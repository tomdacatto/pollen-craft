export const MERGE_VISUAL_DURATION_MS = 340;

export function visualMidpoint(firstRect, secondRect, canvasRect) {
    return {
        x:
            (firstRect.left +
                firstRect.width / 2 +
                secondRect.left +
                secondRect.width / 2) /
                2 -
            canvasRect.left,
        y:
            (firstRect.top +
                firstRect.height / 2 +
                secondRect.top +
                secondRect.height / 2) /
                2 -
            canvasRect.top,
    };
}

export function createMergeAnimationLifecycle({
    duration = MERGE_VISUAL_DURATION_MS,
    reducedMotion = false,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
} = {}) {
    const active = new Map();

    function finish(operation, completed) {
        if (operation.settled) return;
        operation.settled = true;
        if (operation.timer !== null) clearTimer(operation.timer);
        active.delete(operation.id);
        operation.resolve(completed);
    }

    return {
        begin(id) {
            active.get(id)?.cancel();
            let resolve;
            const promise = new Promise((next) => {
                resolve = next;
            });
            const operation = {
                id,
                timer: null,
                settled: false,
                resolve,
                cancel() {
                    finish(operation, false);
                },
            };
            active.set(id, operation);
            if (reducedMotion) finish(operation, true);
            else
                operation.timer = setTimer(
                    () => finish(operation, true),
                    duration,
                );
            return { promise, cancel: operation.cancel };
        },
        cancel(id) {
            active.get(id)?.cancel();
        },
        cancelAll() {
            for (const operation of active.values()) operation.cancel();
        },
        get size() {
            return active.size;
        },
    };
}

export function createMergeAnimation({
    canvas,
    layer,
    duration = MERGE_VISUAL_DURATION_MS,
    reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")
        .matches ?? false,
    requestFrame = globalThis.requestAnimationFrame ??
        ((callback) => setTimeout(callback, 0)),
} = {}) {
    const active = new Map();

    function removeNodes(operation) {
        for (const node of operation.nodes) node.remove();
        operation.nodes = [];
    }

    function finish(operation, completed) {
        if (operation.settled) return;
        operation.settled = true;
        clearTimeout(operation.motionTimer);
        clearTimeout(operation.burstTimer);
        removeNodes(operation);
        active.delete(operation.id);
        if (completed) operation.onComplete?.();
        operation.resolve(completed);
    }

    return {
        begin({
            id,
            sourceElements,
            targetElement = sourceElements[1],
            topmostSourceId,
            onComplete,
        } = {}) {
            active.get(id)?.cancel();
            let resolve;
            const promise = new Promise((next) => {
                resolve = next;
            });
            const operation = {
                id,
                nodes: [],
                motionTimer: null,
                burstTimer: null,
                settled: false,
                resolve,
                onComplete,
                cancel() {
                    finish(operation, false);
                },
            };
            active.set(id, operation);

            const canvasRect = canvas?.getBoundingClientRect?.();
            const sourceRects = sourceElements.map((element) =>
                element.getBoundingClientRect(),
            );
            const midpoint =
                canvasRect && sourceRects.length >= 2
                    ? visualMidpoint(sourceRects[0], sourceRects[1], canvasRect)
                    : null;
            if (reducedMotion || sourceElements.length < 2) {
                queueMicrotask(() => finish(operation, true));
                return {
                    promise,
                    cancel: operation.cancel,
                    midpoint,
                };
            }

            for (const [index, source] of sourceElements.entries()) {
                const rect = sourceRects[index];
                const clone = source.cloneNode(true);
                clone.className = "merge-clone canvas-chip";
                clone.classList.remove(
                    "is-combining",
                    "is-dragging",
                    "is-drop-target",
                );
                clone.setAttribute("aria-hidden", "true");
                clone.removeAttribute("aria-label");
                clone.removeAttribute("aria-busy");
                clone.removeAttribute("aria-disabled");
                clone.style.left = `${rect.left - canvasRect.left}px`;
                clone.style.top = `${rect.top - canvasRect.top}px`;
                clone.style.width = `${rect.width}px`;
                clone.style.height = `${rect.height}px`;
                clone.style.zIndex =
                    source.dataset.instance === topmostSourceId ? "6" : "5";
                clone.style.setProperty(
                    "--merge-dx",
                    `${midpoint.x - (rect.left - canvasRect.left + rect.width / 2)}px`,
                );
                clone.style.setProperty(
                    "--merge-dy",
                    `${midpoint.y - (rect.top - canvasRect.top + rect.height / 2)}px`,
                );
                layer.append(clone);
                operation.nodes.push(clone);
            }
            const highlight = document.createElement("span");
            highlight.className = "merge-target-highlight";
            highlight.setAttribute("aria-hidden", "true");
            const targetRect =
                targetElement?.getBoundingClientRect?.() ?? sourceRects[1];
            highlight.style.left = `${targetRect.left + targetRect.width / 2 - canvasRect.left}px`;
            highlight.style.top = `${targetRect.top + targetRect.height / 2 - canvasRect.top}px`;
            layer.append(highlight);
            operation.nodes.push(highlight);

            requestFrame(() => {
                if (operation.settled) return;
                for (const node of operation.nodes)
                    node.classList.add("is-moving");
            });
            operation.burstTimer = setTimeout(
                () => {
                    if (operation.settled) return;
                    const burst = document.createElement("span");
                    burst.className = "merge-burst";
                    burst.setAttribute("aria-hidden", "true");
                    burst.style.left = `${midpoint.x}px`;
                    burst.style.top = `${midpoint.y}px`;
                    layer.append(burst);
                    operation.nodes.push(burst);
                },
                Math.max(0, duration - 110),
            );
            operation.motionTimer = setTimeout(
                () => finish(operation, true),
                duration,
            );
            return { promise, cancel: operation.cancel, midpoint };
        },
        cancel(id) {
            active.get(id)?.cancel();
        },
        cancelAll() {
            for (const operation of active.values()) operation.cancel();
        },
        get size() {
            return active.size;
        },
    };
}
