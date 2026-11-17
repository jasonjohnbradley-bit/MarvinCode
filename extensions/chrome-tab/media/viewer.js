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
	const share = /** @type {HTMLButtonElement} */ ($('share'));
	const dark = /** @type {HTMLButtonElement} */ ($('dark'));
	const star = /** @type {HTMLButtonElement} */ ($('star'));
	const bookmarkBar = $('bookmarks');
	const bookmarkList = $('bm-list');
	const bookmarkMore = $('bm-more');

	let dpr = window.devicePixelRatio || 1;
	let cssW = 0;
	let cssH = 0;
	/** @type {HTMLImageElement | undefined} */
	let lastImage;
	// The page size, in CSS pixels, the last frame shows.
	let lastImageW = 0;
	let lastImageH = 0;

	/** @param {unknown} message */
	const post = message => vscode.postMessage(message);

	// --- Layout ---

	// Frames are drawn at the page size they show, from the top left, never
	// stretched to the stage: canvas pixels stay page pixels (input relies on it),
	// and while the stage is resized the old frame shows edged in white until
	// Chrome catches up, instead of distorted.
	function draw() {
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		if (!lastImage) {
			return;
		}
		const fits = Math.abs(lastImageW - cssW) <= 1 && Math.abs(lastImageH - cssH) <= 1;
		const w = fits ? canvas.width : Math.round(lastImageW * dpr);
		const h = fits ? canvas.height : Math.round(lastImageH * dpr);
		ctx.drawImage(lastImage, 0, 0, w, h);
	}

	function measure() {
		dpr = window.devicePixelRatio || 1;
		const r = stage.getBoundingClientRect();
		cssW = Math.max(100, Math.floor(r.width));
		cssH = Math.max(100, Math.floor(r.height));
		canvas.style.width = `${cssW}px`;
		canvas.style.height = `${cssH}px`;
		canvas.width = Math.round(cssW * dpr);
		canvas.height = Math.round(cssH * dpr);
		draw();
	}

	// Window zoom or a display with another scale changes devicePixelRatio.
	function watchPixelRatio() {
		matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
			measure();
			watchPixelRatio();
		}, { once: true });
	}
	watchPixelRatio();

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

	/** @param {boolean} value */
	function showShared(value) {
		document.body.classList.toggle('shared', value);
		share.setAttribute('aria-pressed', String(value));
		const title = (value ? share.dataset.unshare : share.dataset.share) || '';
		share.title = title;
		share.setAttribute('aria-label', title);
	}

	/** @param {boolean} value */
	function showDark(value) {
		document.body.classList.toggle('dark', value);
		dark.setAttribute('aria-pressed', String(value));
		const title = (value ? dark.dataset.on : dark.dataset.off) || '';
		dark.title = title;
		dark.setAttribute('aria-label', title);
	}

	// --- Bookmarks ---

	// Chrome's default favicon for sites without one: a grey globe (codicon `globe`).
	const DEFAULT_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="#8a8a8a"><path d="M8 1C4.141 1 1 4.141 1 8C1 11.859 4.141 15 8 15C11.859 15 15 11.859 15 8C15 4.141 11.859 1 8 1ZM8 14C7.422 14 6.686 12.906 6.288 11H9.713C9.315 12.906 8.579 14 8.001 14H8ZM6.121 10C6.044 9.392 6 8.723 6 8C6 7.277 6.044 6.608 6.121 6H9.878C9.955 6.608 9.999 7.277 9.999 8C9.999 8.723 9.955 9.392 9.878 10H6.121ZM2 8C2 7.299 2.121 6.626 2.343 6H5.121C5.041 6.656 5 7.332 5 8C5 8.668 5.041 9.344 5.121 10H2.343C2.121 9.374 2 8.701 2 8ZM8 2C8.578 2 9.314 3.094 9.712 5H6.287C6.685 3.094 7.422 2 8 2ZM10.879 6H13.657C13.879 6.626 14 7.299 14 8C14 8.701 13.879 9.374 13.657 10H10.879C10.959 9.344 11 8.668 11 8C11 7.332 10.959 6.656 10.879 6ZM13.195 5H10.722C10.516 3.938 10.199 2.98 9.775 2.268C11.228 2.719 12.446 3.707 13.195 5ZM6.226 2.268C5.802 2.98 5.484 3.938 5.279 5H2.806C3.556 3.707 4.774 2.718 6.226 2.268ZM2.805 11H5.278C5.484 12.062 5.801 13.02 6.225 13.732C4.772 13.281 3.554 12.293 2.805 11ZM9.774 13.732C10.198 13.02 10.516 12.062 10.721 11H13.194C12.444 12.293 11.226 13.282 9.774 13.732Z"/></svg>');

	/** @type {{ id: string, title: string, url: string, icon?: string }[]} */
	let bookmarks = [];
	let currentUrl = '';

	function renderStar() {
		const on = bookmarks.some(b => b.url === currentUrl);
		star.classList.toggle('on', on);
		star.setAttribute('aria-pressed', String(on));
		star.title = (on ? star.dataset.edit : star.dataset.add) || '';
		star.setAttribute('aria-label', star.title);
		star.disabled = !/^https?:/.test(currentUrl);
	}

	function renderBookmarks() {
		bookmarkList.replaceChildren(...bookmarks.map(b => {
			const item = document.createElement('button');
			item.className = 'bm';
			item.dataset.id = b.id;
			item.title = `${b.title}\n${b.url}`;
			const icon = document.createElement('img');
			icon.alt = '';
			icon.src = b.icon || DEFAULT_ICON;
			icon.addEventListener('error', () => { icon.src = DEFAULT_ICON; }, { once: true });
			const label = document.createElement('span');
			label.textContent = b.title;
			item.append(icon, label);
			return item;
		}));
		bookmarkBar.hidden = bookmarks.length === 0;
		updateOverflow();
		renderStar();
	}

	function updateOverflow() {
		bookmarkMore.hidden = bookmarkList.scrollWidth <= bookmarkList.clientWidth;
	}
	new ResizeObserver(updateOverflow).observe(bookmarkBar);

	/** @param {Event} e */
	const bookmarkId = e => /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('.bm'))?.dataset.id;
	bookmarkList.addEventListener('click', e => {
		const id = bookmarkId(e);
		if (id) {
			post({ type: 'openBookmark', id, newTab: e.metaKey || e.ctrlKey });
		}
	});
	bookmarkList.addEventListener('auxclick', e => {
		const id = bookmarkId(e);
		if (id && e.button === 1) {
			post({ type: 'openBookmark', id, newTab: true });
		}
	});
	bookmarkList.addEventListener('contextmenu', e => {
		e.preventDefault();
		const id = bookmarkId(e);
		if (id) {
			post({ type: 'bookmarkMenu', id });
		}
	});
	bookmarkMore.addEventListener('click', () => post({ type: 'bookmarksOverflow' }));
	star.addEventListener('click', () => post({ type: 'toggleBookmark' }));

	// --- Host messages ---

	// Once connected, the host posts at least every 1.5 s (state, or a ping while
	// hidden). Silence means the extension host went away: it restarted, and VS Code
	// does not hand existing panels to the new one. Say so rather than show a page
	// that looks alive but ignores input.
	let lastHostMessage = 0;
	let disconnected = false;
	setInterval(() => {
		if (!disconnected && lastHostMessage && Date.now() - lastHostMessage > 10000) {
			disconnected = true;
			status.textContent = document.body.dataset.disconnected || '';
			status.hidden = false;
		}
	}, 2000);

	window.addEventListener('message', event => {
		const m = event.data;
		if (lastHostMessage || m.type === 'state') {
			lastHostMessage = Date.now();
		}
		if (disconnected) {
			disconnected = false;
			status.hidden = true;
		}
		switch (m.type) {
			case 'frame': {
				const image = new Image();
				image.onload = () => {
					lastImage = image;
					lastImageW = m.width || cssW;
					lastImageH = m.height || cssH;
					draw();
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
				showShared(!!m.shared);
				currentUrl = m.url;
				renderStar();
				break;
			case 'bookmarks':
				bookmarks = m.items;
				renderBookmarks();
				break;
			case 'cursor':
				canvas.style.cursor = m.value;
				break;
			case 'status':
				status.textContent = m.text;
				status.hidden = !m.text;
				break;
			case 'focusAddressBar':
				urlInput.focus();
				break;
			case 'colorScheme':
				showDark(!!m.dark);
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
		// No nativeVirtualKeyCode: on macOS Chrome reads it as a Mac key code, and a
		// Windows code there turns keys the page leaves alone (Escape, Page Up/Down,
		// F-keys) into Chrome menu shortcuts that open chrome://settings/help.
		post({
			type: 'key',
			event: {
				type: text ? 'keyDown' : 'rawKeyDown',
				key: e.key, code: e.code,
				windowsVirtualKeyCode: e.keyCode,
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
		post({ type: 'key', event: { type: 'keyUp', key: e.key, code: e.code, windowsVirtualKeyCode: e.keyCode, location: e.location, modifiers: modifiers(e) } });
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
	share.addEventListener('click', () => post({ type: 'toggleShare' }));
	dark.addEventListener('click', () => post({ type: 'toggleDarkMode' }));
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
