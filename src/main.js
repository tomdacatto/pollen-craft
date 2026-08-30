import {
    ApiError,
    createApiClient,
    DEFAULT_TEXT_MODEL,
    isSecretKey,
    isTextModel,
    TEXT_MODELS,
} from "./api.js";
import {
    canonicalPair,
    createInitialState,
    displayNameKey,
    findDiscovery,
    gameReducer,
    inventoryItems,
    loadState,
    rectanglesOverlap,
    resolveInventoryItem,
    SEEDS,
    STORAGE_KEY,
    saveState,
} from "./game.js";
import { createImageCache } from "./image-cache.js";

const localStore = safeStorage("localStorage");
const tabStore = safeStorage("sessionStorage");
const api = createApiClient();
const canvas = document.querySelector("#crafting-canvas");
const canvasItems = document.querySelector("#canvas-items");
const inventory = document.querySelector("#inventory-chips");
const search = document.querySelector("#inventory-search");
const resultPopover = document.querySelector("#result-popover");
const resultContent = document.querySelector("#result-content");
const resultLabel = document.querySelector("#result-label");
const retryText = document.querySelector("#retry-text");
const retryImage = document.querySelector("#retry-image");
const live = document.querySelector("#live-region");
const keyInput = document.querySelector("#api-key");
const keyStatus = document.querySelector("#key-status");
const keyForm = document.querySelector("#key-form");
const modelSelect = document.querySelector("#text-model");
const settingsDialog = document.querySelector("#settings-dialog");
const helpDialog = document.querySelector("#help-dialog");
const resetButton = document.querySelector("#reset-game");
const IMAGE_DECODE_TIMEOUT_MS = 15_000;
const TEXT_MODEL_STORAGE_KEY = "pollen-craft:text-model:v2";
let state = loadState(localStore);
let selected = [];
let instances = new Map();
let drag = null;
let inventoryDrag = null;
let suppressInventoryClick = false;
let suppressInventoryChip = null;
let inventoryClickReset = null;
let busy = false;
let generation = 0;
let activeImagePair = null;
let activeDiscovery = null;
let activePopoverImage = null;
let resultAnchor = null;
let focusedPair = null;
let focusedInstanceId = null;
let resultReturnFocus = null;
let resultReturnInstanceId = null;
let activeCombination = null;
let activeImageOperation = null;
const imageOperations = new Map();
let retryTextAvailable = false;
let nextInstanceId = 0;
let nextZIndex = 0;
let nextPopoverRenderToken = 0;

function safeStorage(name) {
    try {
        return globalThis[name];
    } catch {
        return null;
    }
}
function announce(message) {
    live.textContent = message;
}

function currentImageOperation() {
    return activeImageOperation?.imagePairKey === activeImagePair
        ? activeImageOperation
        : null;
}

function reconcileEvictedImage(pairKey, entry) {
    const operations = new Set();
    const cachedOperation = imageOperations.get(pairKey);
    if (cachedOperation) operations.add(cachedOperation);
    if (activeImageOperation?.imagePairKey === pairKey)
        operations.add(activeImageOperation);
    for (const operation of operations) {
        clearImageTimer(operation);
        operation.cancelled = true;
        operation.imagePending = false;
        operation.imageDisplayed = false;
        operation.imageError = true;
        if (operation.imageUrl === entry.url) operation.imageUrl = null;
        if (imageOperations.get(pairKey) === operation)
            imageOperations.delete(pairKey);
        if (activeImageOperation === operation) activeImageOperation = null;
    }
    const popoverImage =
        !resultPopover.hidden &&
        activePopoverImage?.pairKey === pairKey &&
        activePopoverImage.url === entry.url
            ? activePopoverImage
            : null;
    if (popoverImage) {
        const placeholder = document.createElement("div");
        placeholder.className = "result-placeholder";
        placeholder.setAttribute("aria-hidden", "true");
        if (popoverImage.image?.isConnected)
            popoverImage.image.replaceWith(placeholder);
        activePopoverImage = null;
        resultPopover.setAttribute("aria-busy", "false");
    }
    refreshImageVisuals(pairKey);
    updateRetryButtons();
}

const imageCache = createImageCache({
    onEvict(pairKey, entry, reason) {
        if (reason === "evict" || reason === "delete")
            reconcileEvictedImage(pairKey, entry);
        else refreshImageVisuals(pairKey);
    },
});
function handleImageFailure(
    pairKey,
    url,
    operation = null,
    renderToken = null,
    renderedImage = null,
) {
    if (
        renderToken !== null &&
        (activePopoverImage?.token !== renderToken ||
            activePopoverImage.image !== renderedImage)
    )
        return false;
    const cached = imageCache.peek(pairKey);
    if (!cached || cached.url !== url) return false;
    const activeOperation =
        operation ??
        (imageOperations.get(pairKey)?.imageUrl === url
            ? imageOperations.get(pairKey)
            : activeImageOperation?.imagePairKey === pairKey &&
                activeImageOperation.imageUrl === url
              ? activeImageOperation
              : null);
    clearImageTimer(activeOperation);
    if (activeOperation) {
        activeOperation.imagePending = false;
        activeOperation.imageDisplayed = false;
        activeOperation.imageError = true;
        if (imageOperations.get(pairKey) === activeOperation)
            imageOperations.delete(pairKey);
        if (activeImageOperation === activeOperation)
            activeImageOperation = null;
    }
    const popoverImage =
        !resultPopover.hidden &&
        activePopoverImage?.pairKey === pairKey &&
        activePopoverImage.url === url
            ? activePopoverImage
            : null;
    imageCache.delete(pairKey);
    if (!popoverImage) return true;
    activePopoverImage = null;
    resultPopover.setAttribute("aria-busy", "false");
    if (!resultAnchor) {
        updateRetryButtons();
        return true;
    }
    openResult(
        popoverImage.discovery,
        resultAnchor.x,
        resultAnchor.y,
        popoverImage.label,
        null,
        true,
        false,
    );
    announce(
        `${popoverImage.discovery.name} illustration could not be displayed.`,
    );
    return true;
}

function completeImageOperation(pairKey, url) {
    const operation = imageOperations.get(pairKey);
    if (!operation || operation.imageUrl !== url || operation.cancelled)
        return null;
    clearImageTimer(operation);
    operation.imagePending = false;
    operation.imageDisplayed = true;
    imageOperations.delete(pairKey);
    if (activeImageOperation === operation) activeImageOperation = null;
    updateRetryButtons();
    return operation;
}
function clearImageTimer(operation) {
    if (!operation?.imageTimer) return;
    clearTimeout(operation.imageTimer);
    operation.imageTimer = null;
}
function positionResult(x, y) {
    const gutter = 12;
    const canvasRect = canvas.getBoundingClientRect();
    const resultRect = resultPopover.getBoundingClientRect();
    const rightEdge = Math.min(window.innerWidth - gutter, canvasRect.right);
    const bottomEdge = Math.min(window.innerHeight - gutter, canvasRect.bottom);
    const minLeft = Math.max(gutter, canvasRect.left + gutter);
    const minTop = canvasRect.top + gutter;
    const maxLeft = Math.max(minLeft, rightEdge - resultRect.width - gutter);
    const maxTop = Math.max(minTop, bottomEdge - resultRect.height - gutter);
    resultPopover.style.left = `${Math.max(minLeft, Math.min(canvasRect.left + x + 90, maxLeft))}px`;
    resultPopover.style.top = `${Math.max(minTop, Math.min(canvasRect.top + y + 90, maxTop))}px`;
}
function cancelAllImageOperations() {
    for (const operation of imageOperations.values()) {
        operation.cancelled = true;
        operation.imagePending = false;
        clearImageTimer(operation);
    }
    imageOperations.clear();
    activeImageOperation = null;
}
function readTabKey() {
    try {
        const key = tabStore?.getItem("pollen-craft:key") || "";
        if (isSecretKey(key)) return key;
    } catch {
        /* storage may be blocked */
    }
    return "";
}
function getKey() {
    const input = keyInput.value.trim();
    return isSecretKey(input) ? input : readTabKey();
}
function readTextModel() {
    try {
        const model = localStore?.getItem(TEXT_MODEL_STORAGE_KEY) || "";
        if (isTextModel(model)) return model;
    } catch {
        /* storage may be blocked */
    }
    return DEFAULT_TEXT_MODEL;
}
function getTextModel() {
    return isTextModel(modelSelect.value)
        ? modelSelect.value
        : DEFAULT_TEXT_MODEL;
}
function textModelLabel(model) {
    return TEXT_MODELS.find((entry) => entry.id === model)?.label ?? model;
}
function formatApiError(error) {
    if (!(error instanceof ApiError)) return "Something went wrong. Try again.";
    const details = [
        error.code,
        `attempt ${error.attempt}/${error.maxAttempts}`,
    ];
    if (error.model) details.push(`model ${error.model}`);
    return `${error.message} [${details.join("; ")}]`;
}
for (const model of TEXT_MODELS) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.label;
    modelSelect.append(option);
}
modelSelect.value = readTextModel();
function promptForKey() {
    openSettings();
    keyInput.focus();
    announce(
        "A Pollinations sk_ Secret Key is required to combine ingredients.",
    );
}
function itemById(id) {
    return inventoryItems(state).find((item) => item.id === id) ?? null;
}
function discoveryData(item) {
    return item ? { name: item.name, description: item.description } : null;
}
function itemTone(item) {
    const key = item.id ?? item.name;
    const score = [...key].reduce(
        (total, character) => total + character.charCodeAt(0),
        0,
    );
    return ["lavender", "periwinkle", "mint", "lime"][score % 4];
}
function imageElement(url, pairKey) {
    const image = document.createElement("img");
    image.src = url;
    image.alt = "";
    image.setAttribute("aria-hidden", "true");
    image.decoding = "async";
    image.loading = "eager";
    image.addEventListener(
        "load",
        () => {
            if (imageCache.peek(pairKey)?.url !== url) return;
            image
                .closest(".element-visual")
                ?.classList.remove("is-placeholder");
            const operation = completeImageOperation(pairKey, url);
            if (operation && resultPopover.hidden)
                announce(`${operation.discovery.name} illustration ready.`);
        },
        { once: true },
    );
    image.addEventListener("error", () => handleImageFailure(pairKey, url), {
        once: true,
    });
    return image;
}
function updateImageVisual(slot, item) {
    const cached = item.discovered ? imageCache.peek(item.pair) : null;
    slot.classList.toggle("is-placeholder", !cached && item.discovered);
    slot.replaceChildren();
    if (cached) slot.append(imageElement(cached.url, item.pair));
    else if (!item.discovered) {
        const icon = document.createElement("span");
        icon.textContent = item.icon ?? "";
        slot.append(icon);
    }
}
function createElementVisual(item) {
    const slot = document.createElement("span");
    slot.className = "element-visual";
    slot.dataset.pairKey = item.discovered ? item.pair : "";
    slot.setAttribute("aria-hidden", "true");
    updateImageVisual(slot, item);
    return slot;
}
function refreshImageVisuals(pairKey) {
    if (!pairKey) return;
    const item = inventoryItems(state).find((entry) => entry.pair === pairKey);
    if (!item) return;
    for (const slot of document.querySelectorAll(".element-visual"))
        if (slot.dataset.pairKey === pairKey) updateImageVisual(slot, item);
}
function positionWithinCanvas(x, y, width = 44, height = 44) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: Math.max(8, Math.min(x, Math.max(8, rect.width - width - 8))),
        y: Math.max(38, Math.min(y, Math.max(38, rect.height - height - 8))),
    };
}
function findOpenPlacement(item, preferredX, preferredY) {
    const width = Math.min(230, Math.max(80, item.name.length * 8 + 48));
    const height = 44;
    const canvasRect = canvas.getBoundingClientRect();
    const occupied = [...canvasItems.querySelectorAll("[data-instance]")].map(
        (chip) => chip.getBoundingClientRect(),
    );
    const candidates = [
        [preferredX, preferredY],
        [preferredX + 120, preferredY],
        [preferredX - 120, preferredY],
        [preferredX, preferredY + 70],
        [preferredX, preferredY - 70],
        [preferredX + 120, preferredY + 70],
        [preferredX - 120, preferredY + 70],
        [preferredX + 120, preferredY - 70],
        [preferredX - 120, preferredY - 70],
    ];
    for (const [x, y] of candidates) {
        const point = positionWithinCanvas(x, y, width, height);
        const candidate = {
            left: canvasRect.left + point.x,
            right: canvasRect.left + point.x + width,
            top: canvasRect.top + point.y,
            bottom: canvasRect.top + point.y + height,
        };
        if (
            occupied.every(
                (rect) =>
                    candidate.right <= rect.left ||
                    candidate.left >= rect.right ||
                    candidate.bottom <= rect.top ||
                    candidate.top >= rect.bottom,
            )
        )
            return point;
    }
    return positionWithinCanvas(preferredX, preferredY, width, height);
}
function updateRetryButtons() {
    retryText.disabled = busy || !retryTextAvailable;
    retryImage.disabled =
        busy ||
        currentImageOperation()?.imagePending === true ||
        !activeDiscovery ||
        !activeImagePair;
}
function setTextBusy(next) {
    canvas.setAttribute("aria-busy", String(next));
    live.setAttribute("aria-busy", String(next));
}
function setBusy(next) {
    busy = next;
    keyInput.disabled = next;
    document.querySelector("#settings-save").disabled = next;
    document.querySelector("#forget-key").disabled = next;
    modelSelect.disabled = next;
    search.disabled = next;
    resetButton.disabled = next;
    document.querySelector("#settings-open").disabled = next;
    document.querySelector("#help-open").disabled = next;
    for (const button of inventory.querySelectorAll("button"))
        button.disabled = next;
    for (const button of canvasItems.querySelectorAll("button"))
        button.disabled = next;
    updateRetryButtons();
}
function createInstance(item, x, y, isNew = false) {
    const point = positionWithinCanvas(x, y);
    const instance = {
        id: `instance-${nextInstanceId++}`,
        itemId: item.id,
        x: point.x,
        y: point.y,
        zIndex: ++nextZIndex,
    };
    instances.set(instance.id, instance);
    renderCanvas(isNew ? instance.id : null);
    return instance;
}
function renderCanvas(newId = null) {
    const active = document.activeElement?.dataset?.instance;
    if (active) focusedInstanceId = active;
    canvasItems.replaceChildren();
    for (const instance of instances.values()) {
        const item = itemById(instance.itemId);
        if (!item) continue;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = `canvas-chip${instance.id === newId ? " is-new" : ""}`;
        chip.dataset.tone = itemTone(item);
        chip.style.left = `${instance.x}px`;
        chip.style.top = `${instance.y}px`;
        chip.style.zIndex = String(instance.zIndex);
        chip.setAttribute(
            "aria-pressed",
            String(selected.includes(instance.id)),
        );
        chip.dataset.instance = instance.id;
        chip.dataset.pairKey = item.discovered ? item.pair : "";
        chip.disabled = busy;
        const label = document.createElement("span");
        label.textContent = item.name;
        chip.append(createElementVisual(item), label);
        chip.addEventListener("focus", () => {
            focusedInstanceId = instance.id;
        });
        chip.addEventListener("pointerdown", (event) =>
            startDrag(event, instance.id),
        );
        chip.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activateInstance(instance.id);
            }
        });
        canvasItems.append(chip);
        const point = positionWithinCanvas(
            instance.x,
            instance.y,
            chip.offsetWidth,
            chip.offsetHeight,
        );
        instance.x = point.x;
        instance.y = point.y;
        chip.style.left = `${point.x}px`;
        chip.style.top = `${point.y}px`;
    }
    const focusId = newId ?? focusedInstanceId;
    if (focusId)
        canvasItems.querySelector(`[data-instance="${focusId}"]`)?.focus();
}
function renderInventory() {
    const query = displayNameKey(search.value);
    inventory.replaceChildren();
    const items = inventoryItems(state).filter(
        (item) =>
            !query ||
            `${displayNameKey(item.name)} ${displayNameKey(item.description ?? "")}`.includes(
                query,
            ),
    );
    document.querySelector("#inventory-count").textContent = String(
        inventoryItems(state).length,
    );
    document.querySelector("#discovery-total").textContent =
        `${state.order.length} ${state.order.length === 1 ? "discovery" : "discoveries"}`;
    if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "inventory-empty";
        empty.textContent = "No matches";
        inventory.append(empty);
    }
    for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `inventory-chip${item.discovered ? "" : " is-seed"}`;
        button.dataset.tone = itemTone(item);
        button.dataset.pair = item.pair ?? "";
        button.dataset.pairKey = item.discovered ? item.pair : "";
        button.disabled = busy;
        const name = document.createElement("small");
        name.textContent = item.name;
        button.append(createElementVisual(item), name);
        button.addEventListener("pointerdown", (event) =>
            startInventoryDrag(event, item),
        );
        button.addEventListener("click", (event) => {
            if (
                suppressInventoryClick &&
                suppressInventoryChip === event.currentTarget
            ) {
                suppressInventoryClick = false;
                suppressInventoryChip = null;
                clearTimeout(inventoryClickReset);
                inventoryClickReset = null;
                return;
            }
            placeFromInventory(item);
        });
        inventory.append(button);
    }
    if (focusedPair && document.activeElement !== search)
        [...inventory.querySelectorAll("[data-pair]")]
            .find((button) => button.dataset.pair === focusedPair)
            ?.focus();
}
function placeFromInventory(item, x = null, y = null) {
    if (busy) return;
    generation += 1;
    retryTextAvailable = false;
    resultPopover.setAttribute("aria-busy", "false");
    resultPopover.hidden = true;
    resultAnchor = null;
    focusedPair = item.pair ?? null;
    if (item.discovered) {
        activeImagePair = item.pair;
        activeDiscovery = findDiscovery(state, item.pair);
        activeImageOperation = imageOperations.get(item.pair) ?? null;
    } else {
        activeImagePair = null;
        activeDiscovery = null;
        activeImageOperation = null;
    }
    const offset = instances.size;
    const preferredX = x ?? 40 + (offset % 5) * 120;
    const preferredY = y ?? 80 + (Math.floor(offset / 5) % 4) * 70;
    const placement = findOpenPlacement(item, preferredX, preferredY);
    const instance = createInstance(item, placement.x, placement.y, true);
    announce(`${item.name} placed on the canvas.`);
    instance && renderInventory();
    if (item.discovered)
        openResult(
            activeDiscovery,
            instance.x,
            instance.y,
            "In your book",
            null,
            false,
            true,
            activeImageOperation,
        );
}

function isMobileLayout() {
    return globalThis.matchMedia?.("(max-width: 760px)").matches ?? false;
}

function createInventoryDragGhost(item) {
    const ghost = document.createElement("div");
    ghost.className = "inventory-drag-ghost";
    ghost.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = item.name;
    ghost.append(createElementVisual(item), label);
    document.body.append(ghost);
    return ghost;
}

function moveInventoryDragGhost(ghost, event) {
    ghost.style.left = `${event.clientX}px`;
    ghost.style.top = `${event.clientY}px`;
}

function findCollisionAt(clientX, clientY, width, height) {
    const canvasRect = canvas.getBoundingClientRect();
    if (
        clientX < canvasRect.left ||
        clientX > canvasRect.right ||
        clientY < canvasRect.top ||
        clientY > canvasRect.bottom
    )
        return null;
    const source = {
        left: clientX - width / 2,
        right: clientX + width / 2,
        top: clientY - height / 2,
        bottom: clientY + height / 2,
    };
    let best = null;
    let bestDistance = Infinity;
    let bestOrder = Infinity;
    let order = 0;
    for (const other of instances.values()) {
        const target = canvasItems
            .querySelector(`[data-instance="${other.id}"]`)
            ?.getBoundingClientRect();
        if (target && rectanglesOverlap(source, target)) {
            const targetCenter = {
                x: (target.left + target.right) / 2,
                y: (target.top + target.bottom) / 2,
            };
            const distance =
                (clientX - targetCenter.x) ** 2 +
                (clientY - targetCenter.y) ** 2;
            const isBetter =
                !best ||
                other.zIndex > best.zIndex ||
                (other.zIndex === best.zIndex &&
                    (distance < bestDistance ||
                        (distance === bestDistance && order < bestOrder)));
            if (isBetter) {
                best = other;
                bestDistance = distance;
                bestOrder = order;
            }
        }
        order += 1;
    }
    return best;
}

function cleanupDragGhost(ghost) {
    ghost?.remove();
}

function startInventoryDrag(event, item) {
    if (busy || inventoryDrag) return;
    const chip = event.currentTarget;
    chip.setPointerCapture(event.pointerId);
    const current = {
        item,
        chip,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        ghost: null,
    };
    inventoryDrag = current;
    chip.addEventListener("pointermove", moveInventoryDrag);
    chip.addEventListener("pointerup", endInventoryDrag);
    chip.addEventListener("pointercancel", endInventoryDrag);
    chip.addEventListener("lostpointercapture", endInventoryDrag);
    current.cleanup = () => {
        chip.removeEventListener("pointermove", moveInventoryDrag);
        chip.removeEventListener("pointerup", endInventoryDrag);
        chip.removeEventListener("pointercancel", endInventoryDrag);
        chip.removeEventListener("lostpointercapture", endInventoryDrag);
        cleanupDragGhost(current.ghost);
        current.ghost = null;
        setDropTarget(null);
        if (chip.hasPointerCapture?.(current.pointerId))
            chip.releasePointerCapture(current.pointerId);
    };
    function moveInventoryDrag(move) {
        if (!inventoryDrag || inventoryDrag !== current) return;
        const dx = move.clientX - current.startX;
        const dy = move.clientY - current.startY;
        if (!current.moved) {
            const primaryDistance = isMobileLayout()
                ? Math.abs(dy)
                : Math.abs(dx);
            const crossDistance = isMobileLayout()
                ? Math.abs(dx)
                : Math.abs(dy);
            if (primaryDistance <= 4 || primaryDistance < crossDistance) return;
            current.moved = true;
            current.ghost = createInventoryDragGhost(item);
            chip.classList.add("is-dragging");
        }
        moveInventoryDragGhost(current.ghost, move);
        setDropTarget(
            findCollisionAt(
                move.clientX,
                move.clientY,
                current.ghost.offsetWidth,
                current.ghost.offsetHeight,
            ),
        );
        move.preventDefault?.();
    }
    function endInventoryDrag(end) {
        if (!inventoryDrag || inventoryDrag !== current || current.ended)
            return;
        current.ended = true;
        inventoryDrag = null;
        const dropTarget = current.moved
            ? findCollisionAt(
                  end.clientX,
                  end.clientY,
                  current.ghost?.offsetWidth ?? chip.offsetWidth,
                  current.ghost?.offsetHeight ?? chip.offsetHeight,
              )
            : null;
        current.cleanup();
        chip.classList.remove("is-dragging");
        if (!current.moved || end.type !== "pointerup") return;
        suppressInventoryClick = end.type === "pointerup";
        suppressInventoryChip = suppressInventoryClick ? chip : null;
        if (suppressInventoryClick) {
            clearTimeout(inventoryClickReset);
            inventoryClickReset = setTimeout(() => {
                suppressInventoryClick = false;
                suppressInventoryChip = null;
                inventoryClickReset = null;
            }, 0);
        }
        const rect = canvas.getBoundingClientRect();
        if (
            end.clientX >= rect.left &&
            end.clientX <= rect.right &&
            end.clientY >= rect.top &&
            end.clientY <= rect.bottom
        ) {
            const instance = createInstance(
                current.item,
                end.clientX - rect.left - 22,
                end.clientY - rect.top - 22,
                true,
            );
            renderInventory();
            if (dropTarget) combineInstances(instance, dropTarget);
            else announce(`${current.item.name} placed on the canvas.`);
        }
    }
    current.cancel = () => {
        if (!inventoryDrag || inventoryDrag !== current || current.ended)
            return;
        current.ended = true;
        inventoryDrag = null;
        current.cleanup();
        chip.classList.remove("is-dragging");
    };
}
function startDrag(event, id) {
    if (busy || drag) return;
    const instance = instances.get(id);
    if (!instance) return;
    const chip = event.currentTarget;
    instance.zIndex = ++nextZIndex;
    chip.style.zIndex = String(instance.zIndex);
    chip.classList.add("is-dragging");
    chip.setPointerCapture(event.pointerId);
    const canvasRect = canvas.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    const current = {
        id,
        pointerId: event.pointerId,
        offsetX: event.clientX - chipRect.left,
        offsetY: event.clientY - chipRect.top,
        canvasLeft: canvasRect.left,
        canvasTop: canvasRect.top,
        moved: false,
    };
    drag = current;
    chip.addEventListener("pointermove", moveDrag);
    chip.addEventListener("pointerup", endDrag);
    chip.addEventListener("pointercancel", endDrag);
    chip.addEventListener("lostpointercapture", endDrag);
    current.cleanup = () => {
        chip.removeEventListener("pointermove", moveDrag);
        chip.removeEventListener("pointerup", endDrag);
        chip.removeEventListener("pointercancel", endDrag);
        chip.removeEventListener("lostpointercapture", endDrag);
        chip.classList.remove("is-dragging");
        setDropTarget(null);
        if (chip.hasPointerCapture?.(current.pointerId))
            chip.releasePointerCapture(current.pointerId);
    };
    function moveDrag(move) {
        if (!drag || drag !== current) return;
        if (
            Math.abs(move.clientX - event.clientX) +
                Math.abs(move.clientY - event.clientY) >
            4
        )
            drag.moved = true;
        const point = positionWithinCanvas(
            move.clientX - drag.canvasLeft - drag.offsetX,
            move.clientY - drag.canvasTop - drag.offsetY,
            chip.offsetWidth,
            chip.offsetHeight,
        );
        instance.x = point.x;
        instance.y = point.y;
        chip.style.left = `${point.x}px`;
        chip.style.top = `${point.y}px`;
        setDropTarget(drag.moved ? findCollision(instance) : null);
    }
    function endDrag(end) {
        if (!drag || drag !== current || current.ended) return;
        current.ended = true;
        drag = null;
        const other = current.moved ? findCollision(instance) : null;
        current.cleanup();
        if (end.type !== "pointerup") return;
        if (other) combineInstances(instance, other);
        else if (!current.moved) activateInstance(id);
    }
    current.cancel = () => {
        if (!drag || drag !== current || current.ended) return;
        current.ended = true;
        drag = null;
        current.cleanup();
    };
}
function setDropTarget(target) {
    for (const chip of canvasItems.querySelectorAll(".is-drop-target"))
        chip.classList.remove("is-drop-target");
    if (target)
        canvasItems
            .querySelector(`[data-instance="${target.id}"]`)
            ?.classList.add("is-drop-target");
}

function cancelActiveDrags() {
    inventoryDrag?.cancel?.();
    drag?.cancel?.();
    setDropTarget(null);
    clearTimeout(inventoryClickReset);
    inventoryClickReset = null;
    suppressInventoryClick = false;
    suppressInventoryChip = null;
}

function findCollision(instance) {
    const source = canvasItems
        .querySelector(`[data-instance="${instance.id}"]`)
        ?.getBoundingClientRect();
    if (!source) return null;
    const sourceCenter = {
        x: (source.left + source.right) / 2,
        y: (source.top + source.bottom) / 2,
    };
    let best = null;
    let bestDistance = Infinity;
    let bestOrder = Infinity;
    let order = 0;
    for (const other of instances.values()) {
        if (other.id === instance.id) continue;
        const target = canvasItems
            .querySelector(`[data-instance="${other.id}"]`)
            ?.getBoundingClientRect();
        if (target && rectanglesOverlap(source, target)) {
            const targetCenter = {
                x: (target.left + target.right) / 2,
                y: (target.top + target.bottom) / 2,
            };
            const distance =
                (sourceCenter.x - targetCenter.x) ** 2 +
                (sourceCenter.y - targetCenter.y) ** 2;
            const isBetter =
                !best ||
                other.zIndex > best.zIndex ||
                (other.zIndex === best.zIndex &&
                    (distance < bestDistance ||
                        (distance === bestDistance &&
                            (other.id < best.id ||
                                (other.id === best.id && order < bestOrder)))));
            if (isBetter) {
                best = other;
                bestDistance = distance;
                bestOrder = order;
            }
        }
        order += 1;
    }
    return best;
}
function activateInstance(id) {
    if (busy) return;
    generation += 1;
    resultPopover.hidden = true;
    resultPopover.setAttribute("aria-busy", "false");
    resultAnchor = null;
    activeImagePair = null;
    activeDiscovery = null;
    activeImageOperation = null;
    selected = selected.includes(id)
        ? selected.filter((value) => value !== id)
        : selected.length === 1
          ? [...selected, id]
          : [id];
    renderCanvas();
    if (selected.length === 2) {
        const first = instances.get(selected[0]);
        const second = instances.get(selected[1]);
        selected = [];
        combineInstances(first, second);
    }
}
function clearSelectionForCombination() {
    if (!selected.length) return;
    selected = [];
    renderCanvas();
}
function combineInstances(first, second) {
    if (busy || !first || !second || first.id === second.id) return;
    const firstItem = itemById(first.itemId);
    const secondItem = itemById(second.itemId);
    if (!firstItem || !secondItem) return;
    clearSelectionForCombination();
    startCombination({
        firstItem,
        secondItem,
        sourceIds: [first.id, second.id],
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
    });
}
function failImageDecode(operation) {
    if (
        operation.cancelled ||
        operation.imagePending !== true ||
        imageOperations.get(operation.imagePairKey) !== operation
    )
        return;
    handleImageFailure(operation.imagePairKey, operation.imageUrl, operation);
}
function startCombination({
    firstItem,
    secondItem,
    sourceIds = [],
    x,
    y,
    returnFocus = document.activeElement?.isConnected
        ? document.activeElement
        : null,
    returnFocusInstanceId = document.activeElement?.dataset?.instance ?? null,
}) {
    if (busy) return;
    const pairKey = canonicalPair(firstItem.id, secondItem.id);
    const cached = findDiscovery(state, pairKey);
    const cachedItem = cached
        ? resolveInventoryItem(state, pairKey, cached)
        : null;
    const cachedImagePair = cachedItem?.discovered ? cachedItem.pair : null;
    const cachedImageDiscovery = discoveryData(cachedItem);
    const key = getKey();
    const model = getTextModel();
    if (!key && !cached) {
        promptForKey();
        return;
    }
    const operation = {
        id: ++generation,
        pairKey,
        firstItem,
        secondItem,
        model,
        sourceIds:
            sourceIds.length === 2 && sourceIds[0] !== sourceIds[1]
                ? [...sourceIds]
                : [],
        discovery: cached ? { ...cached } : null,
        x,
        y,
        returnFocus,
        returnFocusInstanceId,
        imagePairKey: cachedImagePair,
        imageDiscovery: cachedImageDiscovery,
    };
    activeCombination = operation;
    retryTextAvailable = false;
    activeImagePair = cachedImagePair;
    activeDiscovery = cachedImageDiscovery ?? operation.discovery;
    activeImageOperation = cachedImagePair
        ? (imageOperations.get(cachedImagePair) ?? null)
        : null;
    resultPopover.hidden = true;
    resultPopover.setAttribute("aria-busy", "false");
    resultAnchor = null;
    setBusy(true);
    setTextBusy(!cached);
    renderCanvas();
    announce(`Combining ${firstItem.name} + ${secondItem.name}`);
    (async () => {
        let stage = cached ? "image" : "idea";
        try {
            const discovery =
                cached ||
                (await api.discoverText(
                    { first: firstItem, second: secondItem },
                    key,
                    operation.model,
                ));
            if (operation.id !== generation) return;
            setTextBusy(false);
            operation.discovery = { ...discovery };
            if (!cached)
                state = saveState(
                    gameReducer(state, {
                        type: "discover",
                        pair: pairKey,
                        discovery,
                    }),
                    localStore,
                );
            renderInventory();
            const resultItem = resolveInventoryItem(state, pairKey, discovery);
            if (!resultItem)
                throw new ApiError(
                    "The discovered idea could not be placed. Retry the idea.",
                    "parse",
                    0,
                    true,
                );
            operation.imagePairKey = resultItem.discovered
                ? resultItem.pair
                : null;
            operation.imageDiscovery = discoveryData(resultItem);
            activeImagePair = operation.imagePairKey;
            activeDiscovery = operation.imageDiscovery;
            activeImageOperation = operation.imagePairKey
                ? (imageOperations.get(operation.imagePairKey) ?? null)
                : null;
            for (const sourceId of operation.sourceIds)
                instances.delete(sourceId);
            operation.sourceIds = [];
            const resultInstance = createInstance(
                resultItem,
                operation.x,
                operation.y,
                true,
            );
            setBusy(false);
            renderCanvas(resultInstance.id);
            const cachedImage = operation.imagePairKey
                ? imageCache.get(operation.imagePairKey)
                : null;
            if (cached)
                openResult(
                    activeDiscovery,
                    operation.x,
                    operation.y,
                    "In your book",
                    cachedImage?.url ?? null,
                    false,
                    false,
                    activeImageOperation,
                );
            announce(
                cached
                    ? `${activeDiscovery.name} is ready from your book.`
                    : `${activeDiscovery.name} discovered and added to your book.`,
            );
            stage = "image";
            if (key && !cachedImage && operation.imagePairKey)
                loadImage(operation, key);
        } catch (error) {
            if (operation.id === generation) {
                setTextBusy(false);
                setBusy(false);
                if (stage === "idea") {
                    resultReturnFocus = operation.returnFocus;
                    resultReturnInstanceId =
                        operation.returnFocusInstanceId ??
                        operation.sourceIds[0] ??
                        null;
                }
                openError(error, stage, operation.x, operation.y);
            }
        }
    })();
}
function updateOpenPopoverImage(operation, imageUrl, imageOperation = null) {
    if (
        resultPopover.hidden ||
        activeImagePair !== operation.imagePairKey ||
        !activeDiscovery ||
        !resultAnchor
    )
        return;
    openResult(
        activeDiscovery,
        resultAnchor.x,
        resultAnchor.y,
        "Illustrated",
        imageUrl,
        false,
        false,
        imageOperation,
    );
}
async function loadImage(operation, key) {
    if (
        operation.imagePending ||
        !operation.imagePairKey ||
        !operation.imageDiscovery ||
        operation.cancelled
    )
        return;
    if (!isSecretKey(key)) {
        if (activeImagePair === operation.imagePairKey) promptForKey();
        return;
    }
    const pending = imageOperations.get(operation.imagePairKey);
    if (pending?.imagePending) {
        if (activeImagePair === operation.imagePairKey)
            activeImageOperation = pending;
        updateRetryButtons();
        return;
    }
    const cached = imageCache.get(operation.imagePairKey);
    if (cached) {
        operation.imageUrl = cached.url;
        operation.imageDisplayed = true;
        operation.imagePending = false;
        refreshImageVisuals(operation.imagePairKey);
        updateOpenPopoverImage(operation, cached.url);
        updateRetryButtons();
        return;
    }
    operation.imagePending = true;
    operation.imageDisplayed = false;
    operation.imageError = false;
    imageOperations.set(operation.imagePairKey, operation);
    if (activeImagePair === operation.imagePairKey) {
        activeImageOperation = operation;
        resultPopover.setAttribute("aria-busy", "true");
    }
    updateRetryButtons();
    try {
        const blob = await api.generateImage(operation.imageDiscovery, key);
        if (
            operation.cancelled ||
            imageOperations.get(operation.imagePairKey) !== operation
        )
            return;
        const imageUrl = imageCache.set(operation.imagePairKey, blob);
        operation.imageUrl = imageUrl;
        refreshImageVisuals(operation.imagePairKey);
        updateOpenPopoverImage(operation, imageUrl, operation);
        operation.imageTimer = setTimeout(
            () => failImageDecode(operation),
            IMAGE_DECODE_TIMEOUT_MS,
        );
    } catch (error) {
        if (!operation.cancelled) {
            operation.imageError = true;
            if (
                !resultPopover.hidden &&
                activeImagePair === operation.imagePairKey &&
                resultAnchor
            )
                openError(
                    error,
                    "image",
                    resultAnchor.x,
                    resultAnchor.y,
                    activeDiscovery ?? operation.imageDiscovery,
                );
            else
                announce(
                    `${operation.imageDiscovery.name} illustration unavailable. Open it to retry the image.`,
                );
        }
    } finally {
        if (operation.cancelled || !operation.imageUrl) {
            operation.imagePending = false;
            if (imageOperations.get(operation.imagePairKey) === operation)
                imageOperations.delete(operation.imagePairKey);
            if (activeImageOperation === operation) {
                activeImageOperation = null;
                if (activeImagePair === operation.imagePairKey)
                    resultPopover.setAttribute("aria-busy", "false");
            }
            updateRetryButtons();
        }
    }
}
function openResult(
    discovery,
    x,
    y,
    label = "Discovery",
    imageUrl = null,
    failed = false,
    focusPanel = true,
    imageOperation = null,
) {
    if (!discovery) return;
    const imagePairKey = imageOperation?.imagePairKey ?? activeImagePair;
    const cachedUrl = imagePairKey ? imageCache.peek(imagePairKey)?.url : null;
    const displayedImageUrl = imageUrl ?? cachedUrl;
    if (resultPopover.hidden) {
        resultReturnFocus = document.activeElement?.isConnected
            ? document.activeElement
            : null;
        resultReturnInstanceId =
            document.activeElement?.dataset?.instance ?? null;
    }
    resultPopover.hidden = false;
    resultPopover.setAttribute(
        "aria-busy",
        String(Boolean(imageOperation?.imagePending)),
    );
    resultAnchor = { x, y };
    resultLabel.textContent = label;
    resultContent.replaceChildren();
    activePopoverImage = null;
    if (displayedImageUrl) {
        const renderToken = ++nextPopoverRenderToken;
        activePopoverImage = {
            pairKey: imagePairKey,
            url: displayedImageUrl,
            token: renderToken,
            discovery,
            label,
        };
        const image = document.createElement("img");
        image.className = "result-image";
        image.setAttribute(
            "aria-busy",
            String(Boolean(imageOperation?.imagePending)),
        );
        image.src = displayedImageUrl;
        image.alt = `${discovery.name} illustration`;
        image.loading = "eager";
        image.decoding = "async";
        image.addEventListener(
            "load",
            () => {
                if (
                    !imagePairKey ||
                    activeImagePair !== imagePairKey ||
                    imageCache.peek(imagePairKey)?.url !== displayedImageUrl ||
                    activePopoverImage?.token !== renderToken ||
                    activePopoverImage.image !== image
                ) {
                    return;
                }
                completeImageOperation(imagePairKey, displayedImageUrl);
                if (
                    imageOperation &&
                    imageOperation.imageUrl === displayedImageUrl
                ) {
                    clearImageTimer(imageOperation);
                    imageOperation.imagePending = false;
                    imageOperation.imageDisplayed = true;
                    if (activeImageOperation === imageOperation)
                        activeImageOperation = null;
                }
                image.setAttribute("aria-busy", "false");
                resultPopover.setAttribute("aria-busy", "false");
                updateRetryButtons();
                announce(`${discovery.name} illustration ready.`);
            },
            { once: true },
        );
        image.addEventListener(
            "error",
            () =>
                handleImageFailure(
                    imagePairKey,
                    displayedImageUrl,
                    imageOperation,
                    renderToken,
                    image,
                ),
            { once: true },
        );
        activePopoverImage.image = image;
        resultContent.append(image);
    } else {
        const placeholder = document.createElement("div");
        placeholder.className = "result-placeholder";
        placeholder.setAttribute("aria-hidden", "true");
        resultContent.append(placeholder);
    }
    const name = document.createElement("h2");
    name.className = "result-name";
    name.id = "result-title";
    name.textContent = discovery.name;
    const description = document.createElement("p");
    description.className = "result-description";
    description.textContent = discovery.description;
    resultContent.append(name, description);
    if (failed) {
        const message = document.createElement("p");
        message.className = "result-message";
        message.textContent = "Illustration unavailable. Retry the image.";
        resultContent.append(message);
    }
    updateRetryButtons();
    positionResult(x, y);
    if (focusPanel) document.querySelector("#result-close")?.focus();
}
function openError(error, stage, x, y, discovery = activeDiscovery) {
    const messageText = formatApiError(error);
    if (!discovery) {
        resultPopover.hidden = false;
        resultPopover.setAttribute("aria-busy", "false");
        resultAnchor = { x, y };
        resultLabel.textContent = "Try again";
        resultContent.replaceChildren();
        activePopoverImage = null;
        const title = document.createElement("h2");
        title.className = "result-name";
        title.id = "result-title";
        title.textContent = "Idea unavailable";
        const message = document.createElement("p");
        message.className = "result-message";
        message.textContent = messageText;
        resultContent.append(title, message);
        retryTextAvailable = stage === "idea";
        retryText.disabled = !retryTextAvailable;
        retryImage.disabled = true;
        positionResult(x, y);
        announce(messageText);
        document.querySelector("#result-close")?.focus();
        return;
    }
    openResult(discovery, x, y, "Try again", null, stage === "image", false);
    const message = document.createElement("p");
    message.className = "result-message";
    message.textContent = messageText;
    resultContent.append(message);
    positionResult(x, y);
    retryTextAvailable = false;
    retryImage.disabled =
        stage !== "image" || currentImageOperation()?.imagePending === true;
    announce(messageText);
}
function closeResult() {
    generation += 1;
    setTextBusy(false);
    resultPopover.hidden = true;
    activePopoverImage = null;
    resultAnchor = null;
    activeImagePair = null;
    activeDiscovery = null;
    activeCombination = null;
    activeImageOperation = null;
    retryTextAvailable = false;
    resultPopover.setAttribute("aria-busy", "false");
    const returnFocus = resultReturnFocus;
    resultReturnFocus = null;
    const fallback = resultReturnInstanceId
        ? canvasItems.querySelector(
              `[data-instance="${resultReturnInstanceId}"]`,
          )
        : null;
    resultReturnInstanceId = null;
    const focusTarget = returnFocus?.isConnected ? returnFocus : fallback;
    if (focusTarget && !focusTarget.disabled) focusTarget.focus();
}
function cancelCombination() {
    if (!busy) return;
    generation += 1;
    setTextBusy(false);
    setBusy(false);
    selected = [];
    activeImagePair = null;
    activeDiscovery = null;
    activeCombination = null;
    activeImageOperation = null;
    retryTextAvailable = false;
    resultPopover.hidden = true;
    resultAnchor = null;
    resultPopover.setAttribute("aria-busy", "false");
    renderCanvas();
    announce(
        "Combination cancelled. Your ingredients are still on the canvas.",
    );
}
function openSettings() {
    if (!busy) settingsDialog.showModal();
    modelSelect.value = readTextModel();
    const modelText = `Text model: ${textModelLabel(getTextModel())}.`;
    keyStatus.textContent = isSecretKey(getKey())
        ? `Key ready for this tab. ${modelText}`
        : `No key added yet. ${modelText}`;
}

search.addEventListener("input", renderInventory);
document
    .querySelector("#settings-open")
    .addEventListener("click", openSettings);
document.querySelector("#help-open").addEventListener("click", () => {
    if (!busy) helpDialog.showModal();
});
keyForm.addEventListener("submit", (event) => {
    if (event.submitter?.value === "cancel") return;
    event.preventDefault();
    const model = getTextModel();
    try {
        localStore?.setItem(TEXT_MODEL_STORAGE_KEY, model);
    } catch {
        /* storage may be blocked */
    }
    const enteredKey = keyInput.value.trim();
    if (enteredKey && !isSecretKey(enteredKey)) {
        keyInput.value = "";
        const existingKey = readTabKey();
        keyStatus.textContent = existingKey
            ? `That is not a valid sk_ Secret Key. Existing tab key kept. Text model: ${textModelLabel(model)}.`
            : `That is not a valid sk_ Secret Key. Text model saved: ${textModelLabel(model)}.`;
        announce("That is not a valid sk_ Secret Key. No key was changed.");
        return;
    }
    if (enteredKey) {
        try {
            tabStore?.setItem("pollen-craft:key", enteredKey);
        } catch {
            /* storage may be blocked */
        }
        keyStatus.textContent = `Settings saved for this tab. Text model: ${textModelLabel(model)}.`;
        settingsDialog.close();
        announce("Settings saved for this tab.");
        return;
    }
    const existingKey = readTabKey();
    keyStatus.textContent = existingKey
        ? `Settings saved for this tab. Key ready. Text model: ${textModelLabel(model)}.`
        : `Text model saved: ${textModelLabel(model)}. Add a Pollinations sk_ Secret Key to generate discoveries.`;
    announce(
        existingKey
            ? "Settings saved for this tab."
            : "Text model saved. A Pollinations sk_ Secret Key is still required.",
    );
});
document.querySelector("#forget-key").addEventListener("click", () => {
    keyInput.value = "";
    try {
        tabStore?.removeItem("pollen-craft:key");
    } catch {
        /* storage may be blocked */
    }
    keyStatus.textContent = `No key added yet. Text model: ${textModelLabel(getTextModel())}.`;
});
document.querySelector("#result-close").addEventListener("click", closeResult);
retryImage.addEventListener("click", () => {
    if (
        !busy &&
        currentImageOperation()?.imagePending !== true &&
        activeDiscovery &&
        activeImagePair
    ) {
        const key = getKey();
        if (!isSecretKey(key)) {
            promptForKey();
            return;
        }
        const anchor = resultAnchor ?? { x: 20, y: 62 };
        const imageDiscovery = discoveryData(activeDiscovery);
        const operation = {
            id: ++generation,
            imagePairKey: activeImagePair,
            discovery: imageDiscovery,
            imageDiscovery,
            x: anchor.x,
            y: anchor.y,
            cancelled: false,
        };
        imageCache.delete(operation.imagePairKey);
        activeImageOperation = operation;
        loadImage(operation, key);
    }
});
retryText.addEventListener("click", () => {
    if (!busy && retryTextAvailable && activeCombination)
        startCombination({
            firstItem: activeCombination.firstItem,
            secondItem: activeCombination.secondItem,
            sourceIds: activeCombination.sourceIds,
            x: activeCombination.x,
            y: activeCombination.y,
            returnFocus: activeCombination.returnFocus,
            returnFocusInstanceId: activeCombination.returnFocusInstanceId,
        });
});
resetButton.addEventListener("click", () => {
    if (busy || !globalThis.confirm("Reset your local discovery book?")) return;
    generation += 1;
    cancelActiveDrags();
    cancelAllImageOperations();
    state = createInitialState();
    try {
        localStore?.removeItem(STORAGE_KEY);
    } catch {
        /* storage may be blocked */
    }
    instances = new Map();
    imageCache.clear();
    nextInstanceId = 0;
    nextZIndex = 0;
    selected = [];
    closeResult();
    renderCanvas();
    renderInventory();
    announce("Your local book was reset.");
});
globalThis.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        if (settingsDialog.open || helpDialog.open) return;
        if (busy) {
            event.preventDefault();
            cancelCombination();
            return;
        }
        if (!resultPopover.hidden) {
            event.preventDefault();
            closeResult();
        } else if (!selected.length || busy) return;
        else {
            selected = [];
            renderCanvas();
        }
    }
});
globalThis.addEventListener("resize", () => {
    for (const instance of instances.values())
        Object.assign(instance, positionWithinCanvas(instance.x, instance.y));
    renderCanvas();
    if (!resultPopover.hidden && resultAnchor)
        positionResult(resultAnchor.x, resultAnchor.y);
});
globalThis.addEventListener("pagehide", () => {
    generation += 1;
    cancelActiveDrags();
    cancelAllImageOperations();
    imageCache.clear();
});

for (const [index, seed] of SEEDS.entries())
    createInstance(
        seed,
        70 + (index % 2) * 180,
        90 + Math.floor(index / 2) * 110,
    );
renderCanvas();
renderInventory();
