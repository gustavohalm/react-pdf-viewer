/**
 * A React component to view a PDF document
 *
 * @see https://react-pdf-viewer.dev
 * @license https://react-pdf-viewer.dev/license
 * @copyright 2019-2022 Nguyen Huu Phuoc <me@phuoc.ng>
 */

import * as React from 'react';
import { useDebounceCallback } from '../hooks/useDebounceCallback';
import { useIsomorphicLayoutEffect } from '../hooks/useIsomorphicLayoutEffect';
import { usePrevious } from '../hooks/usePrevious';
import { useRenderQueue } from '../hooks/useRenderQueue';
import { useTrackResize } from '../hooks/useTrackResize';
import { useVirtual } from '../hooks/useVirtual';
import { PageLayer } from '../layers/PageLayer';
import { LocalizationContext } from '../localization/LocalizationContext';
import { RotateDirection } from '../structs/RotateDirection';
import { ScrollMode } from '../structs/ScrollMode';
import { SpecialZoomLevel } from '../structs/SpecialZoomLevel';
import { TextDirection, ThemeContext } from '../theme/ThemeContext';
import type { DocumentLoadEvent } from '../types/DocumentLoadEvent';
import type { LocalizationMap } from '../types/LocalizationMap';
import type { OpenFile } from '../types/OpenFile';
import type { PageChangeEvent } from '../types/PageChangeEvent';
import type { PageSize } from '../types/PageSize';
import type { PdfJs } from '../types/PdfJs';
import type { Plugin } from '../types/Plugin';
import type { DestinationOffsetFromViewport, PluginFunctions } from '../types/PluginFunctions';
import type { Rect } from '../types/Rect';
import type { RenderPage } from '../types/RenderPage';
import type { RotateEvent } from '../types/RotateEvent';
import type { RotatePageEvent } from '../types/RotatePageEvent';
import type { Slot } from '../types/Slot';
import type { ViewerState } from '../types/ViewerState';
import type { ZoomEvent } from '../types/ZoomEvent';
import { classNames } from '../utils/classNames';
import { getFileExt } from '../utils/getFileExt';
import { clearPagesCache, getPage } from '../utils/managePages';
import { calculateScale } from './calculateScale';

const NUM_OVERSCAN_PAGES = 3;

export const Inner: React.FC<{
    currentFile: OpenFile;
    defaultScale?: number | SpecialZoomLevel;
    doc: PdfJs.PdfDocument;
    initialPage: number;
    pageSize: PageSize;
    plugins: Plugin[];
    renderPage?: RenderPage;
    scrollMode: ScrollMode;
    viewerState: ViewerState;
    onDocumentLoad(e: DocumentLoadEvent): void;
    onOpenFile(fileName: string, data: Uint8Array): void;
    onPageChange(e: PageChangeEvent): void;
    onRotate(e: RotateEvent): void;
    onRotatePage(e: RotatePageEvent): void;
    onZoom(e: ZoomEvent): void;
}> = ({
    currentFile,
    defaultScale,
    doc,
    initialPage,
    pageSize,
    plugins,
    renderPage,
    scrollMode,
    viewerState,
    onDocumentLoad,
    onOpenFile,
    onPageChange,
    onRotate,
    onRotatePage,
    onZoom,
}) => {
    const { numPages } = doc;
    const docId = doc.loadingTask.docId;
    const { l10n } = React.useContext(LocalizationContext);
    const themeContext = React.useContext(ThemeContext);
    const isRtl = themeContext.direction === TextDirection.RightToLeft;
    const containerRef = React.useRef<HTMLDivElement>();
    const pagesRef = React.useRef<HTMLDivElement>();
    const [currentPage, setCurrentPage] = React.useState(initialPage);
    const [rotation, setRotation] = React.useState(0);
    // The rotation for each page
    const [pagesRotationChanged, setPagesRotationChanged] = React.useState(false);
    const [pagesRotation, setPagesRotation] = React.useState(new Map<number, number>());

    const [currentScrollMode, setCurrentScrollMode] = React.useState(scrollMode);
    const previousScrollMode = usePrevious(currentScrollMode);

    const [scale, setScale] = React.useState(pageSize.scale);
    const stateRef = React.useRef<ViewerState>(viewerState);
    const keepSpecialZoomLevelRef = React.useRef<SpecialZoomLevel | null>(
        typeof defaultScale === 'string' ? defaultScale : null
    );

    const [renderPageIndex, setRenderPageIndex] = React.useState(-1);
    const [renderQueueKey, setRenderQueueKey] = React.useState(0);
    const renderQueue = useRenderQueue({ doc });
    React.useEffect(() => {
        return () => {
            clearPagesCache();
        };
    }, [docId]);

    const estimateSize = React.useCallback(() => {
        const sizes = [pageSize.pageHeight, pageSize.pageWidth];
        const rect: Rect =
            Math.abs(rotation) % 180 === 0
                ? {
                      height: sizes[0],
                      width: sizes[1],
                  }
                : {
                      height: sizes[1],
                      width: sizes[0],
                  };
        return {
            height: rect.height * scale,
            width: rect.width * scale,
        };
    }, [rotation, scale]);

    const setStartRange = React.useCallback((startIndex: number) => Math.max(startIndex - NUM_OVERSCAN_PAGES, 0), []);
    const setEndRange = React.useCallback(
        (endIndex: number) => Math.min(endIndex + NUM_OVERSCAN_PAGES, numPages - 1),
        [numPages]
    );
    const transformSize = React.useCallback((size: Rect) => size, []);

    const virtualizer = useVirtual({
        estimateSize,
        isRtl,
        numberOfItems: numPages,
        parentRef: pagesRef,
        scrollMode: currentScrollMode,
        setStartRange,
        setEndRange,
        transformSize,
    });

    const handlePagesResize = useDebounceCallback((_) => {
        if (keepSpecialZoomLevelRef.current) {
            // Mark all pages as not rendered yet
            setRenderPageIndex(-1);
            zoom(keepSpecialZoomLevelRef.current);
        }
    }, 200);

    useTrackResize({
        targetRef: pagesRef,
        onResize: handlePagesResize,
    });

    const { pageWidth, pageHeight } = pageSize;

    // The methods that a plugin can hook on.
    // These methods are registered once and there is no chance for plugins to get the latest version of the methods.
    // Hence, don't pass any dependencies or internal states if they use React hooks such as React.useCallback()

    const setViewerState = (viewerState: ViewerState) => {
        let newState = viewerState;
        // Loop over the plugins and notify the state changed
        plugins.forEach((plugin) => {
            if (plugin.onViewerStateChange) {
                newState = plugin.onViewerStateChange(newState);
            }
        });
        stateRef.current = newState;
    };

    const getPagesContainer = () => pagesRef.current;

    const getViewerState = () => stateRef.current;

    const jumpToDestination = React.useCallback(
        (
            pageIndex: number,
            bottomOffset: number | DestinationOffsetFromViewport,
            leftOffset: number | DestinationOffsetFromViewport,
            scaleTo?: number | SpecialZoomLevel
        ): void => {
            const pagesContainer = pagesRef.current;
            const currentState = stateRef.current;
            if (!pagesContainer || !currentState) {
                return;
            }

            getPage(doc, pageIndex).then((page) => {
                const viewport = page.getViewport({ scale: 1 });
                let top = 0;
                const bottom =
                    (typeof bottomOffset === 'function'
                        ? bottomOffset(viewport.width, viewport.height)
                        : bottomOffset) || 0;
                let left =
                    (typeof leftOffset === 'function' ? leftOffset(viewport.width, viewport.height) : leftOffset) || 0;
                let updateScale = currentState.scale;

                switch (scaleTo) {
                    case SpecialZoomLevel.PageFit:
                        top = 0;
                        left = 0;
                        zoom(SpecialZoomLevel.PageFit);
                        break;
                    case SpecialZoomLevel.PageWidth:
                        updateScale = calculateScale(pagesContainer, pageHeight, pageWidth, SpecialZoomLevel.PageWidth);
                        top = (viewport.height - bottom) * updateScale;
                        left = left * updateScale;
                        zoom(updateScale);
                        break;
                    default:
                        const boundingRect = viewport.convertToViewportPoint(left, bottom);
                        left = Math.max(boundingRect[0] * currentState.scale, 0);
                        top = Math.max(boundingRect[1] * currentState.scale, 0);
                        break;
                }

                switch (currentState.scrollMode) {
                    case ScrollMode.Horizontal:
                        virtualizer.scrollToItem(pageIndex, { left, top: 0 });
                        break;
                    case ScrollMode.Vertical:
                    default:
                        virtualizer.scrollToItem(pageIndex, { left: 0, top });
                        break;
                }
            });
        },
        []
    );

    const jumpToPage = React.useCallback((pageIndex: number) => {
        if (0 <= pageIndex && pageIndex < numPages) {
            virtualizer.scrollToItem(pageIndex, { left: 0, top: 0 });
        }
    }, []);

    const openFile = React.useCallback(
        (file: File) => {
            if (getFileExt(file.name).toLowerCase() !== 'pdf') {
                return;
            }
            new Promise<Uint8Array>((resolve) => {
                const reader = new FileReader();
                reader.readAsArrayBuffer(file);
                reader.onload = (): void => {
                    const bytes = new Uint8Array(reader.result as ArrayBuffer);
                    resolve(bytes);
                };
            }).then((data) => {
                onOpenFile(file.name, data);
            });
        },
        [onOpenFile]
    );

    const rotate = React.useCallback((direction: RotateDirection) => {
        const degrees = direction === RotateDirection.Backward ? -90 : 90;
        const currentRotation = stateRef.current.rotation;
        const updateRotation =
            currentRotation === 360 || currentRotation === -360 ? degrees : currentRotation + degrees;

        renderQueue.markNotRendered();
        setRotation(updateRotation);
        setViewerState({
            ...stateRef.current,
            rotation: updateRotation,
        });
        onRotate({ direction, doc, rotation: updateRotation });
    }, []);

    const rotatePage = React.useCallback((pageIndex: number, direction: RotateDirection) => {
        const degrees = direction === RotateDirection.Backward ? -90 : 90;
        const rotations = stateRef.current.pagesRotation;
        const currentPageRotation = rotations.has(pageIndex) ? rotations.get(pageIndex) : 0;
        const finalRotation = currentPageRotation + degrees;
        const updateRotations = rotations.set(pageIndex, finalRotation);

        setPagesRotation(updateRotations);
        // Force the pages to be re-virtualized
        setPagesRotationChanged((value) => !value);
        setViewerState({
            ...stateRef.current,
            pagesRotation: updateRotations,
            rotatedPage: pageIndex,
        });
        onRotatePage({ direction, doc, pageIndex, rotation: finalRotation });

        // Rerender the target page
        renderQueue.markRendering(pageIndex);
        setRenderPageIndex(pageIndex);
    }, []);

    const switchScrollMode = React.useCallback((scrollMode: ScrollMode) => {
        setViewerState({
            ...stateRef.current,
            scrollMode,
        });
        setCurrentScrollMode(scrollMode);
    }, []);

    const zoom = React.useCallback((newScale: number | SpecialZoomLevel) => {
        const pagesEle = pagesRef.current;
        let updateScale = pagesEle
            ? typeof newScale === 'string'
                ? calculateScale(pagesEle, pageHeight, pageWidth, newScale)
                : newScale
            : 1;

        keepSpecialZoomLevelRef.current = typeof newScale === 'string' ? newScale : null;
        if (updateScale === stateRef.current.scale) {
            // Prevent the case where users continue zooming
            // when the document reaches the minimum/maximum zooming scale
            return;
        }

        virtualizer.zoom(updateScale / stateRef.current.scale);

        setRenderQueueKey((key) => key + 1);
        renderQueue.markNotRendered();

        setScale(updateScale);
        onZoom({ doc, scale: updateScale });

        setViewerState({
            ...stateRef.current,
            scale: updateScale,
        });
    }, []);

    // Internal
    // --------

    React.useEffect(() => {
        const pluginMethods: PluginFunctions = {
            getPagesContainer,
            getViewerState,
            jumpToDestination,
            jumpToPage,
            openFile,
            rotate,
            rotatePage,
            setViewerState,
            switchScrollMode,
            zoom,
        };

        // Install the plugins
        plugins.forEach((plugin) => {
            if (plugin.install) {
                plugin.install(pluginMethods);
            }
        });

        return () => {
            // Uninstall the plugins
            plugins.forEach((plugin) => {
                if (plugin.uninstall) {
                    plugin.uninstall(pluginMethods);
                }
            });
        };
    }, [docId]);

    React.useEffect(() => {
        onDocumentLoad({ doc, file: currentFile });
        // Loop over the plugins
        plugins.forEach((plugin) => {
            plugin.onDocumentLoad && plugin.onDocumentLoad({ doc, file: currentFile });
        });
        if (initialPage) {
            jumpToPage(initialPage);
        }
    }, [docId]);

    // Scroll to the current page after switching the scroll mode
    useIsomorphicLayoutEffect(() => {
        const latestPage = stateRef.current.pageIndex;
        if (latestPage > -1 && previousScrollMode !== currentScrollMode) {
            virtualizer.scrollToItem(latestPage, { left: 0, top: 0 });
        }
    }, [currentScrollMode]);

    React.useEffect(() => {
        const { isSmoothScrolling } = virtualizer;
        if (isSmoothScrolling) {
            return;
        }
        if (
            (stateRef.current.pageIndex === -1 && currentPage === initialPage) ||
            (currentPage === stateRef.current.pageIndex && currentPage !== initialPage)
        ) {
            onPageChange({ currentPage, doc });
        }
    }, [currentPage, virtualizer.isSmoothScrolling]);

    // This hook should be placed at the end of hooks
    React.useEffect(() => {
        const { startRange, endRange, maxVisbilityIndex, virtualItems } = virtualizer;
        // The current page is the page which has the biggest visibility
        const currentPage = maxVisbilityIndex;

        setCurrentPage(currentPage);
        setViewerState({
            ...stateRef.current,
            pageIndex: currentPage,
        });

        // The range of pages that will be rendered
        renderQueue.setRange(startRange, endRange);
        for (let i = startRange; i <= endRange; i++) {
            const item = virtualItems.find((item) => item.index === i);
            if (item) {
                renderQueue.setVisibility(i, item.visibility);
            }
        }

        renderNextPage();
    }, [
        virtualizer.startRange,
        virtualizer.endRange,
        virtualizer.maxVisbilityIndex,
        pagesRotationChanged,
        rotation,
        scale,
    ]);

    const handlePageRenderCompleted = React.useCallback(
        (pageIndex: number) => {
            renderQueue.markRendered(pageIndex);
            renderNextPage();
        },
        [renderQueueKey]
    );

    const renderNextPage = () => {
        const nextPage = renderQueue.getHighestPriorityPage();
        if (nextPage > -1 && renderQueue.isInRange(nextPage)) {
            renderQueue.markRendering(nextPage);
            setRenderPageIndex(nextPage);
        }
    };

    // `action` can be `FirstPage`, `PrevPage`, `NextPage`, `LastPage`, `GoBack`, `GoForward`
    const executeNamedAction = (action: string): void => {
        const previousPage = currentPage - 1;
        const nextPage = currentPage + 1;
        switch (action) {
            case 'FirstPage':
                jumpToPage(0);
                break;
            case 'LastPage':
                jumpToPage(numPages - 1);
                break;
            case 'NextPage':
                nextPage < numPages && jumpToPage(nextPage);
                break;
            case 'PrevPage':
                previousPage >= 0 && jumpToPage(previousPage);
                break;
            default:
                break;
        }
    };

    const renderViewer = React.useCallback(() => {
        const pageLabel =
            l10n && l10n.core ? ((l10n.core as LocalizationMap).pageLabel as string) : 'Page {{pageIndex}}';
        let slot: Slot = {
            attrs: {
                'data-testid': 'core__inner-container',
                ref: containerRef,
                style: {
                    height: '100%',
                },
            },
            children: <></>,
            subSlot: {
                attrs: {
                    'data-testid': 'core__inner-pages',
                    className: classNames({
                        'rpv-core__inner-pages': true,
                        'rpv-core__inner-pages--horizontal': currentScrollMode === ScrollMode.Horizontal,
                        'rpv-core__inner-pages--rtl': isRtl,
                        'rpv-core__inner-pages--vertical': currentScrollMode === ScrollMode.Vertical,
                        'rpv-core__inner-pages--wrapped': currentScrollMode === ScrollMode.Wrapped,
                    }),
                    ref: pagesRef,
                    style: {
                        height: '100%',
                        overflow: 'auto',
                        // We need this to jump between destinations or searching results
                        position: 'relative',
                    },
                },
                children: (
                    <div style={virtualizer.getContainerStyles()}>
                        {virtualizer.virtualItems.map((item) => (
                            <div
                                aria-label={pageLabel.replace('{{pageIndex}}', `${item.index + 1}`)}
                                className="rpv-core__inner-page"
                                key={item.index}
                                role="region"
                                style={virtualizer.getItemStyles(item)}
                            >
                                <PageLayer
                                    doc={doc}
                                    height={pageHeight}
                                    measureRef={item.measureRef}
                                    pageIndex={item.index}
                                    pageRotation={pagesRotation.has(item.index) ? pagesRotation.get(item.index) : 0}
                                    plugins={plugins}
                                    renderPage={renderPage}
                                    renderQueueKey={renderQueueKey}
                                    rotation={rotation}
                                    scale={scale}
                                    shouldRender={renderPageIndex === item.index}
                                    width={pageWidth}
                                    onExecuteNamedAction={executeNamedAction}
                                    onJumpToDest={jumpToDestination}
                                    onRenderCompleted={handlePageRenderCompleted}
                                    onRotatePage={rotatePage}
                                />
                            </div>
                        ))}
                    </div>
                ),
            },
        };

        plugins.forEach((plugin) => {
            if (plugin.renderViewer) {
                slot = plugin.renderViewer({
                    containerRef,
                    doc,
                    pageHeight,
                    pageWidth,
                    pagesRotation,
                    rotation,
                    slot,
                    themeContext,
                    jumpToPage,
                    openFile,
                    rotate,
                    rotatePage,
                    switchScrollMode,
                    zoom,
                });
            }
        });

        return slot;
    }, [plugins, virtualizer]);

    const renderSlot = React.useCallback(
        (slot: Slot) => (
            <div {...slot.attrs} style={slot.attrs && slot.attrs.style ? slot.attrs.style : {}}>
                {slot.children}
                {slot.subSlot && renderSlot(slot.subSlot)}
            </div>
        ),
        []
    );

    return renderSlot(renderViewer());
};
