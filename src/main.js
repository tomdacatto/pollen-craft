import { ApiError, createApiClient, isAppKey } from "./api.js";
import {
    canonicalPair,
    createInitialState,
    findDiscovery,
    gameReducer,
    inventoryItems,
    loadState,
    SEEDS,
    saveState,
} from "./game.js";

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
const settingsDialog = document.querySelector("#settings-dialog");
const helpDialog = document.querySelector("#help-dialog");
const resetButton = document.querySelector("#reset-game");
const IMAGE_DECODE_TIMEOUT_MS = 15_000;
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
let activePair = null;
let activeDiscovery = null;
let activeObjectUrl = null;
let resultAnchor = null;
let focusedPair = null;
let focusedInstanceId = null;
let resultReturnFocus = null;
let resultReturnInstanceId = null;
let activeCombination = null;
let activeImageOperation = null;
let retryTextAvailable = false;
let nextInstanceId = 0;

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
function revokeImage() {
    if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
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
function cancelImageOperation() {
    clearImageTimer(activeImageOperation);
    if (activeImageOperation) activeImageOperation.imagePending = false;
    activeImageOperation = null;
}
function readTabKey() {
    try {
        const key = tabStore?.getItem("pollen-craft:key") || "";
        if (isAppKey(key)) return key;
        tabStore?.removeItem("pollen-craft:key");
    } catch {
        /* storage may be blocked */
    }
    return "";
}
function getKey() {
    return keyInput.value.trim() || readTabKey();
}
function promptForKey() {
    openSettings();
    keyInput.focus();
    announce("A registered pk_ App Key is required to combine ingredients.");
}
function itemById(id) {
    return inventoryItems(state).find((item) => item.id === id) ?? null;
}
function itemTone(item) {
    const key = item.id ?? item.name;
    const score = [...key].reduce(
        (total, character) => total + character.charCodeAt(0),
        0,
    );
    return ["lavender", "periwinkle", "mint", "lime"][score % 4];
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
        busy || activeImageOperation?.imagePending === true || !activeDiscovery;
}
function setTextBusy(next) {
    canvas.setAttribute("aria-busy", String(next));
    live.setAttribute("aria-busy", String(next));
}
function setBusy(next) {
    busy = next;
    keyInput.disabled = next;
    document.querySelector("#key-save").disabled = next;
    document.querySelector("#forget-key").disabled = next;
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
        chip.setAttribute(
            "aria-pressed",
            String(selected.includes(instance.id)),
        );
        chip.dataset.instance = instance.id;
        chip.disabled = busy;
        const icon = document.createElement("span");
        icon.className = "chip-icon";
        icon.textContent = item.icon ?? "✦";
        icon.setAttribute("aria-hidden", "true");
        const label = document.createElement("span");
        label.textContent = item.name;
        chip.append(icon, label);
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
    const query = search.value.trim().toLowerCase();
    inventory.replaceChildren();
    const items = inventoryItems(state).filter((item) =>
        `${item.name} ${item.description ?? ""}`.toLowerCase().includes(query),
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
        button.disabled = busy;
        const icon = document.createElement("span");
        icon.textContent = item.icon ?? "✦";
        icon.setAttribute("aria-hidden", "true");
        const name = document.createElement("small");
        name.textContent = item.name;
        button.append(icon, name);
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
    cancelImageOperation();
    revokeImage();
    retryTextAvailable = false;
    resultPopover.setAttribute("aria-busy", "false");
    resultPopover.hidden = true;
    resultAnchor = null;
    focusedPair = item.pair ?? null;
    if (item.discovered) {
        activePair = item.pair;
        activeDiscovery = findDiscovery(state, item.pair);
    } else {
        activePair = null;
        activeDiscovery = null;
    }
    const offset = instances.size;
    const preferredX = x ?? 40 + (offset % 5) * 120;
    const preferredY = y ?? 80 + (Math.floor(offset / 5) % 4) * 70;
    const placement = findOpenPlacement(item, preferredX, preferredY);
    const instance = createInstance(item, placement.x, placement.y, true);
    announce(`${item.name} placed on the canvas.`);
    instance && renderInventory();
    if (item.discovered)
        openResult(activeDiscovery, instance.x, instance.y, "In your book");
}
function startInventoryDrag(event, item) {
    if (busy || inventoryDrag) return;
    const chip = event.currentTarget;
    chip.setPointerCapture(event.pointerId);
    inventoryDrag = {
        item,
        chip,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
    };
    chip.addEventListener("pointermove", moveInventoryDrag);
    chip.addEventListener("pointerup", endInventoryDrag);
    chip.addEventListener("pointercancel", endInventoryDrag);
    function moveInventoryDrag(move) {
        if (!inventoryDrag || inventoryDrag.chip !== chip) return;
        if (
            Math.abs(move.clientX - inventoryDrag.startX) +
                Math.abs(move.clientY - inventoryDrag.startY) >
            4
        )
            inventoryDrag.moved = true;
    }
    function endInventoryDrag(end) {
        if (!inventoryDrag || inventoryDrag.chip !== chip) return;
        const current = inventoryDrag;
        inventoryDrag = null;
        chip.removeEventListener("pointermove", moveInventoryDrag);
        chip.removeEventListener("pointerup", endInventoryDrag);
        chip.removeEventListener("pointercancel", endInventoryDrag);
        if (chip.hasPointerCapture?.(current.pointerId))
            chip.releasePointerCapture(current.pointerId);
        if (!current.moved) return;
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
            placeFromInventory(
                current.item,
                end.clientX - rect.left - 22,
                end.clientY - rect.top - 22,
            );
        }
    }
}
function startDrag(event, id) {
    if (busy || drag) return;
    const instance = instances.get(id);
    if (!instance) return;
    const chip = event.currentTarget;
    chip.setPointerCapture(event.pointerId);
    const canvasRect = canvas.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    drag = {
        id,
        pointerId: event.pointerId,
        offsetX: event.clientX - chipRect.left,
        offsetY: event.clientY - chipRect.top,
        canvasLeft: canvasRect.left,
        canvasTop: canvasRect.top,
        moved: false,
    };
    chip.addEventListener("pointermove", moveDrag);
    chip.addEventListener("pointerup", endDrag);
    chip.addEventListener("pointercancel", endDrag);
    function moveDrag(move) {
        if (!drag || drag.id !== id) return;
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
    }
    function endDrag() {
        if (!drag || drag.id !== id) return;
        const current = drag;
        drag = null;
        chip.removeEventListener("pointermove", moveDrag);
        chip.removeEventListener("pointerup", endDrag);
        chip.removeEventListener("pointercancel", endDrag);
        if (chip.hasPointerCapture?.(current.pointerId))
            chip.releasePointerCapture(current.pointerId);
        const other = current.moved ? findCollision(instance) : null;
        if (other) combineInstances(instance, other);
        else if (!current.moved) activateInstance(id);
    }
}
function findCollision(instance) {
    const source = canvasItems
        .querySelector(`[data-instance="${instance.id}"]`)
        ?.getBoundingClientRect();
    if (!source) return null;
    for (const other of instances.values()) {
        if (other.id === instance.id) continue;
        const target = canvasItems
            .querySelector(`[data-instance="${other.id}"]`)
            ?.getBoundingClientRect();
        if (
            target &&
            source.left < target.right &&
            source.right > target.left &&
            source.top < target.bottom &&
            source.bottom > target.top
        )
            return other;
    }
    return null;
}
function activateInstance(id) {
    if (busy) return;
    generation += 1;
    cancelImageOperation();
    revokeImage();
    resultPopover.hidden = true;
    resultPopover.setAttribute("aria-busy", "false");
    resultAnchor = null;
    activePair = null;
    activeDiscovery = null;
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
function combineInstances(first, second) {
    if (busy || !first || !second || first.id === second.id) return;
    const firstItem = itemById(first.itemId);
    const secondItem = itemById(second.itemId);
    if (!firstItem || !secondItem) return;
    startCombination({
        firstItem,
        secondItem,
        sourceIds: [first.id, second.id],
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
    });
}
function failImageDecode(operation) {
    if (operation.id !== generation || activeImageOperation !== operation)
        return;
    clearImageTimer(operation);
    operation.imagePending = false;
    activeImageOperation = null;
    revokeImage();
    resultPopover.setAttribute("aria-busy", "false");
    announce(
        `${operation.discovery.name} illustration could not be displayed.`,
    );
    openResult(
        operation.discovery,
        operation.x,
        operation.y,
        "Illustrated",
        null,
        true,
        false,
    );
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
    const key = getKey();
    if (!key && !cached) {
        promptForKey();
        return;
    }
    const operation = {
        id: ++generation,
        pairKey,
        firstItem,
        secondItem,
        sourceIds:
            sourceIds.length === 2 && sourceIds[0] !== sourceIds[1]
                ? [...sourceIds]
                : [],
        discovery: cached ? { ...cached } : null,
        x,
        y,
        returnFocus,
        returnFocusInstanceId,
    };
    activeCombination = operation;
    cancelImageOperation();
    retryTextAvailable = false;
    activePair = pairKey;
    activeDiscovery = operation.discovery;
    revokeImage();
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
                ));
            if (operation.id !== generation) return;
            setTextBusy(false);
            operation.discovery = { ...discovery };
            activeDiscovery = operation.discovery;
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
            const resultItem = inventoryItems(state).find(
                (item) => item.pair === pairKey,
            ) ?? {
                ...discovery,
                id: `discovery-${encodeURIComponent(pairKey)}`,
                discovered: true,
            };
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
            openResult(
                operation.discovery,
                operation.x,
                operation.y,
                cached ? "In your book" : "New discovery",
                null,
                false,
                false,
            );
            announce(`${operation.discovery.name} discovered.`);
            stage = "image";
            if (key) loadImage(operation, key);
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
async function loadImage(operation, key) {
    if (operation.imagePending || !operation.discovery) return;
    if (!isAppKey(key)) {
        promptForKey();
        return;
    }
    operation.imagePending = true;
    activeImageOperation = operation;
    resultPopover.setAttribute("aria-busy", "true");
    updateRetryButtons();
    try {
        const blob = await api.generateImage(operation.discovery, key);
        if (operation.id !== generation) return;
        revokeImage();
        activeObjectUrl = URL.createObjectURL(blob);
        operation.imageDisplayed = true;
        openResult(
            operation.discovery,
            operation.x,
            operation.y,
            "Illustrated",
            activeObjectUrl,
            false,
            false,
            operation,
        );
        if (operation.imagePending)
            operation.imageTimer = setTimeout(
                () => failImageDecode(operation),
                IMAGE_DECODE_TIMEOUT_MS,
            );
    } catch (error) {
        if (operation.id === generation)
            openError(
                error,
                "image",
                operation.x,
                operation.y,
                operation.discovery,
            );
    } finally {
        if (!operation.imageDisplayed || operation.id !== generation) {
            operation.imagePending = false;
        }
        if (
            activeImageOperation === operation &&
            (!operation.imageDisplayed || operation.id !== generation)
        ) {
            operation.imagePending = false;
            activeImageOperation = null;
            resultPopover.setAttribute("aria-busy", "false");
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
    if (resultPopover.hidden) {
        resultReturnFocus = document.activeElement?.isConnected
            ? document.activeElement
            : null;
        resultReturnInstanceId =
            document.activeElement?.dataset?.instance ?? null;
    }
    resultPopover.hidden = false;
    resultPopover.setAttribute("aria-busy", "false");
    resultAnchor = { x, y };
    resultLabel.textContent = label;
    resultContent.replaceChildren();
    if (imageUrl) {
        resultPopover.setAttribute("aria-busy", "true");
        const image = document.createElement("img");
        image.className = "result-image";
        image.setAttribute("aria-busy", "true");
        image.src = imageUrl;
        image.alt = `${discovery.name} illustration`;
        image.loading = "lazy";
        image.addEventListener(
            "load",
            () => {
                if (
                    imageOperation &&
                    imageOperation.id === generation &&
                    activeImageOperation === imageOperation
                ) {
                    clearImageTimer(imageOperation);
                    imageOperation.imagePending = false;
                    activeImageOperation = null;
                    image.setAttribute("aria-busy", "false");
                    resultPopover.setAttribute("aria-busy", "false");
                    updateRetryButtons();
                    announce(`${discovery.name} illustration ready.`);
                }
            },
            { once: true },
        );
        image.addEventListener(
            "error",
            () => {
                if (imageUrl !== activeObjectUrl) return;
                if (imageOperation && imageOperation.id !== generation) return;
                clearImageTimer(imageOperation);
                if (imageOperation) imageOperation.imagePending = false;
                if (activeImageOperation === imageOperation)
                    activeImageOperation = null;
                image.setAttribute("aria-busy", "false");
                revokeImage();
                resultPopover.setAttribute("aria-busy", "false");
                announce(
                    `${discovery.name} illustration could not be displayed.`,
                );
                openResult(discovery, x, y, label, null, true, false);
            },
            { once: true },
        );
        resultContent.append(image);
    } else {
        const placeholder = document.createElement("div");
        placeholder.className = "result-placeholder";
        placeholder.textContent = "✦";
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
    const messageText =
        error instanceof ApiError
            ? error.message
            : "Something went wrong. Try again.";
    if (!discovery) {
        resultPopover.hidden = false;
        resultPopover.setAttribute("aria-busy", "false");
        resultAnchor = { x, y };
        resultLabel.textContent = "Try again";
        resultContent.replaceChildren();
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
        stage !== "image" || activeImageOperation?.imagePending === true;
    announce(messageText);
}
function closeResult() {
    generation += 1;
    setTextBusy(false);
    resultPopover.hidden = true;
    resultAnchor = null;
    cancelImageOperation();
    revokeImage();
    activePair = null;
    activeDiscovery = null;
    activeCombination = null;
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
    cancelImageOperation();
    setTextBusy(false);
    setBusy(false);
    selected = [];
    activePair = null;
    activeDiscovery = null;
    activeCombination = null;
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
    keyStatus.textContent = isAppKey(getKey())
        ? "Key ready for this tab."
        : "No key added yet.";
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
    const key = keyInput.value.trim();
    if (!isAppKey(key)) {
        try {
            tabStore?.removeItem("pollen-craft:key");
        } catch {
            /* storage may be blocked */
        }
        keyStatus.textContent = "Use a registered pk_ App Key (pk_…).";
        announce("That is not a valid pk_ App Key.");
        return;
    }
    try {
        tabStore?.setItem("pollen-craft:key", key);
    } catch {
        /* storage may be blocked */
    }
    keyStatus.textContent = "Key ready for this tab.";
    settingsDialog.close();
    announce("Key saved for this tab.");
});
document.querySelector("#forget-key").addEventListener("click", () => {
    keyInput.value = "";
    try {
        tabStore?.removeItem("pollen-craft:key");
    } catch {
        /* storage may be blocked */
    }
    keyStatus.textContent = "No key added yet.";
});
document.querySelector("#result-close").addEventListener("click", closeResult);
retryImage.addEventListener("click", () => {
    if (
        !busy &&
        activeImageOperation?.imagePending !== true &&
        activeDiscovery
    ) {
        const anchor = resultAnchor ?? { x: 20, y: 62 };
        const operation = {
            id: ++generation,
            pairKey: activePair,
            discovery: { ...activeDiscovery },
            x: anchor.x,
            y: anchor.y,
        };
        loadImage(operation, getKey());
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
    state = createInitialState();
    try {
        localStore?.removeItem("pollen-craft:game:v1");
    } catch {
        /* storage may be blocked */
    }
    instances = new Map();
    nextInstanceId = 0;
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
    cancelImageOperation();
    revokeImage();
});

for (const [index, seed] of SEEDS.entries())
    createInstance(
        seed,
        70 + (index % 2) * 180,
        90 + Math.floor(index / 2) * 110,
    );
renderCanvas();
renderInventory();
