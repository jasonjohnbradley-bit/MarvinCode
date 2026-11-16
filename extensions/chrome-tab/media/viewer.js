/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
// Chrome Tab viewer: draws screencast frames from headless Chrome and sends input
// back as CDP Input.dispatch* parameters. Text keys go to a hidden textarea so dead
// keys and IME composition work; Cmd shortcuts that are not editing commands are
// left to the workbench (Cmd+P, Cmd+W, ...).
(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();

	/** @param {string} id */
	const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
	const canvas = /** @type {HTMLCanvasElement} */ ($('screen'));
	const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
	const stage = $('stage');
	const sink = /** @type {HTMLTextAreaElement} */ ($('sink'));
	const status = $('status');
	const urlInput = /** @type {HTMLInputElement} */ ($('url'));
	const back = /** @type {HTMLButtonElement} */ ($('back'));
	const forward = /** @type {HTMLButtonElement} */ ($('forward'));
	const shared = $('shared');

	const dpr = window.devicePixelRatio || 1;
	let cssW = 0;
	let cssH = 0;
	/** @type {HTMLImageElement | undefined} */
	let lastImage;

	/** @param {unknown} message */
	const post = message => vscode.postMessage(message);

	// --- Layout ---

	function measure() {
		const r = stage.getBoundingClientRect();
		cssW = Math.max(100, Math.floor(r.width));
		cssH = Math.max(100, Math.floor(r.height));
		canvas.style.width = `${cssW}px`;
		canvas.style.height = `${cssH}px`;
		canvas.width = Math.round(cssW * dpr);
		canvas.height = Math.round(cssH * dpr);
		if (lastImage) {
			ctx.drawImage(lastImage, 0, 0, canvas.width, canvas.height);
		}
	}

	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let resizeTimer;
	new ResizeObserver(() => {
		const w = cssW;
		const h = cssH;
		measure();
		if (w === cssW && h === cssH) {
			return;
		}
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => post({ type: 'resize', width: cssW, height: cssH }), 80);
	}).observe(stage);

	// --- Host messages ---

	window.addEventListener('message', event => {
		const m = event.data;
		switch (m.type) {
			case 'frame': {
				const image = new Image();
				image.onload = () => {
					lastImage = image;
					ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
					status.hidden = true;
					post({ type: 'drawn' });
				};
				image.onerror = () => post({ type: 'drawn' });
				image.src = `data:image/jpeg;base64,${m.data}`;
				break;
			}
			case 'state':
				// Lets the serializer reopen this URL after a window reload.
				vscode.setState({ url: m.url, title: m.title });
				if (document.activeElement !== urlInput) {
					urlInput.value = m.url === 'about:blank' ? '' : m.url;
				}
				back.disabled = !m.canGoBack;
				forward.disabled = !m.canGoForward;
				shared.hidden = !m.shared;
				break;
			case 'cursor':
				canvas.style.cursor = m.value;
				break;
			case 'status':
				status.textContent = m.text;
				status.hidden = !m.text;
				break;
		}
	});

	// --- Mouse ---

	/** @param {MouseEvent | KeyboardEvent} e */
	const modifiers = e => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
	const BUTTONS = ['left', 'middle', 'right', 'back', 'forward'];
	/** @param {MouseEvent} e */
	function point(e) {
		const r = canvas.getBoundingClientRect();
		return { x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top) };
	}

	let pressedButton = 'none';
	/** @param {string} type @param {MouseEvent} e @param {number} clickCount */
	function sendMouse(type, e, clickCount) {
		post({
			type: 'mouse',
			event: { type, ...point(e), button: type === 'mouseMoved' ? pressedButton : (BUTTONS[e.button] || 'left'), buttons: e.buttons, clickCount, modifiers: modifiers(e) },
		});
	}

	function focusSink() {
		sink.focus({ preventScroll: true });
	}

	canvas.addEventListener('mousedown', e => {
		e.preventDefault();
		focusSink();
		pressedButton = BUTTONS[e.button] || 'left';
		sendMouse('mousePressed', e, e.detail || 1);
	});
	window.addEventListener('mouseup', e => {
		if (pressedButton === 'none') {
			return;
		}
		sendMouse('mouseReleased', e, e.detail || 1);
		pressedButton = 'none';
	});

	/** @type {MouseEvent | undefined} */
	let pendingMove;
	let lastProbe = 0;
	window.addEventListener('mousemove', e => {
		if (e.target !== canvas && pressedButton === 'none') {
			return;
		}
		if (!pendingMove) {
			requestAnimationFrame(() => {
				if (pendingMove) {
					sendMouse('mouseMoved', pendingMove, 0);
					pendingMove = undefined;
				}
			});
		}
		pendingMove = e;
		const now = Date.now();
		if (e.target === canvas && now - lastProbe > 120) {
			lastProbe = now;
			post({ type: 'cursorProbe', ...point(e) });
		}
	});
	canvas.addEventListener('contextmenu', e => e.preventDefault());

	let wheelX = 0;
	let wheelY = 0;
	/** @type {WheelEvent | undefined} */
	let wheelEvent;
	canvas.addEventListener('wheel', e => {
		e.preventDefault();
		const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? cssH : 1;
		wheelX += e.deltaX * unit;
		wheelY += e.deltaY * unit;
		if (!wheelEvent) {
			requestAnimationFrame(() => {
				const w = /** @type {WheelEvent} */ (wheelEvent);
				post({ type: 'mouse', event: { type: 'mouseWheel', ...point(w), deltaX: wheelX, deltaY: wheelY, modifiers: modifiers(w), button: 'none' } });
				wheelX = 0;
				wheelY = 0;
				wheelEvent = undefined;
			});
		}
		wheelEvent = e;
	}, { passive: false });

	// --- Keyboard ---

	// macOS Chrome performs editing through NSResponder commands; headless Chrome
	// needs them spelled out (same table Playwright uses, minus insert*).
	/** @type {Record<string, string>} */
	const EDIT_COMMANDS = {
		'Backspace': 'deleteBackward', 'Shift+Backspace': 'deleteBackward', 'Alt+Backspace': 'deleteWordBackward', 'Meta+Backspace': 'deleteToBeginningOfLine',
		'Delete': 'deleteForward', 'Alt+Delete': 'deleteWordForward', 'Meta+Delete': 'deleteToEndOfLine',
		'Escape': 'cancelOperation',
		'ArrowUp': 'moveUp', 'ArrowDown': 'moveDown', 'ArrowLeft': 'moveLeft', 'ArrowRight': 'moveRight',
		'Shift+ArrowUp': 'moveUpAndModifySelection', 'Shift+ArrowDown': 'moveDownAndModifySelection',
		'Shift+ArrowLeft': 'moveLeftAndModifySelection', 'Shift+ArrowRight': 'moveRightAndModifySelection',
		'Alt+ArrowLeft': 'moveWordLeft', 'Alt+ArrowRight': 'moveWordRight',
		'Shift+Alt+ArrowLeft': 'moveWordLeftAndModifySelection', 'Shift+Alt+ArrowRight': 'moveWordRightAndModifySelection',
		'Meta+ArrowLeft': 'moveToLeftEndOfLine', 'Meta+ArrowRight': 'moveToRightEndOfLine',
		'Shift+Meta+ArrowLeft': 'moveToLeftEndOfLineAndModifySelection', 'Shift+Meta+ArrowRight': 'moveToRightEndOfLineAndModifySelection',
		'Meta+ArrowUp': 'moveToBeginningOfDocument', 'Meta+ArrowDown': 'moveToEndOfDocument',
		'Shift+Meta+ArrowUp': 'moveToBeginningOfDocumentAndModifySelection', 'Shift+Meta+ArrowDown': 'moveToEndOfDocumentAndModifySelection',
		'Home': 'scrollToBeginningOfDocument', 'End': 'scrollToEndOfDocument', 'PageUp': 'scrollPageUp', 'PageDown': 'scrollPageDown',
		'Meta+KeyA': 'selectAll', 'Meta+KeyZ': 'undo', 'Shift+Meta+KeyZ': 'redo',
	};
	/** @param {KeyboardEvent} e */
	function shortcut(e) {
		const parts = [];
		if (e.shiftKey) { parts.push('Shift'); }
		if (e.ctrlKey) { parts.push('Control'); }
		if (e.altKey) { parts.push('Alt'); }
		if (e.metaKey) { parts.push('Meta'); }
		parts.push(e.code);
		return parts.join('+');
	}
	/** @param {KeyboardEvent} e */
	const composing = e => e.isComposing || e.keyCode === 229 || e.key === 'Dead';

	sink.addEventListener('keydown', e => {
		if (composing(e)) {
			return;
		}
		const command = EDIT_COMMANDS[shortcut(e)];
		if (e.metaKey && !command) {
			// The workbench also routes Cmd+C/X/V into this webview; handle them here
			// against Chrome's selection and leave every other Cmd shortcut alone.
			if (e.code === 'KeyC' || e.code === 'KeyX' || e.code === 'KeyV') {
				post({ type: 'clipboard', action: e.code === 'KeyC' ? 'copy' : e.code === 'KeyX' ? 'cut' : 'paste' });
			}
			return;
		}
		e.preventDefault();
		const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
		const text = printable ? e.key : e.key === 'Enter' ? '\r' : undefined;
		post({
			type: 'key',
			event: {
				type: text ? 'keyDown' : 'rawKeyDown',
				key: e.key, code: e.code,
				windowsVirtualKeyCode: e.keyCode, nativeVirtualKeyCode: e.keyCode,
				text, unmodifiedText: text,
				autoRepeat: e.repeat, location: e.location, isKeypad: e.location === 3,
				modifiers: modifiers(e),
				commands: command ? [command] : undefined,
			},
		});
	});
	sink.addEventListener('keyup', e => {
		if (composing(e) || (e.metaKey && !EDIT_COMMANDS[shortcut(e)])) {
			return;
		}
		post({ type: 'key', event: { type: 'keyUp', key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, nativeVirtualKeyCode: e.keyCode, location: e.location, modifiers: modifiers(e) } });
	});
	let composingText = false;
	sink.addEventListener('compositionstart', () => { composingText = true; });
	sink.addEventListener('compositionend', e => {
		composingText = false;
		if (e.data) {
			post({ type: 'insertText', text: e.data });
		}
		sink.value = '';
	});
	sink.addEventListener('input', event => {
		if (composingText) {
			return;
		}
		// Handled keydowns are preventDefault-ed and never reach here, so plain text
		// insertion is text that arrived without a key (dictation, emoji picker).
		// Pastes (insertFromPaste) are already done through the host clipboard.
		const e = /** @type {InputEvent} */ (event);
		if ((e.inputType === 'insertText' || e.inputType === 'insertReplacementText') && e.data) {
			post({ type: 'insertText', text: e.data });
		}
		sink.value = '';
	});

	// --- Toolbar ---

	back.addEventListener('click', () => post({ type: 'history', action: 'back' }));
	forward.addEventListener('click', () => post({ type: 'history', action: 'forward' }));
	$('reload').addEventListener('click', () => post({ type: 'history', action: 'reload' }));
	$('external').addEventListener('click', () => post({ type: 'openExternal' }));
	$('unshare').addEventListener('click', () => post({ type: 'stopSharing' }));
	$('nav').addEventListener('submit', e => {
		e.preventDefault();
		if (urlInput.value.trim()) {
			post({ type: 'navigate', url: urlInput.value });
			focusSink();
		}
	});
	urlInput.addEventListener('focus', () => urlInput.select());
	urlInput.addEventListener('keydown', e => {
		if (e.key === 'Escape') {
			urlInput.blur();
			focusSink();
		}
	});

	measure();
	post({ type: 'ready', width: cssW, height: cssH, dpr });
}());
