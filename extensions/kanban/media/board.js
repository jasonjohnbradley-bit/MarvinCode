/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();
	const boardEl = /** @type {HTMLElement} */ (document.getElementById('board'));

	/** Cards rendered per column before the "Show more" button takes over. */
	const RENDER_CAP = 50;

	let state;
	const ui = vscode.getState() || { filter: '', priorityFilter: '', blockedOnly: false, collapsed: {}, extraShown: {}, drawerCardId: undefined };

	function saveUi() {
		vscode.setState(ui);
	}

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) {
			node.className = className;
		}
		if (text !== undefined) {
			node.textContent = text;
		}
		return node;
	}

	function icon(name, className) {
		return el('i', `codicon codicon-${name}${className ? ' ' + className : ''}`);
	}

	function allCards() {
		return state ? state.columns.flatMap(column => column.cards) : [];
	}

	function cardById(id) {
		return allCards().find(card => card.id === id);
	}

	// ---------- Filtering ----------

	function matchesFilter(card) {
		if (ui.blockedOnly && !card.blocked) {
			return false;
		}
		if (ui.priorityFilter && card.priority !== ui.priorityFilter) {
			return false;
		}
		const query = ui.filter.trim().toLowerCase();
		if (!query) {
			return true;
		}
		return card.title.toLowerCase().includes(query)
			|| card.id.toLowerCase().includes(query)
			|| (card.jira && card.jira.toLowerCase().includes(query))
			|| card.labels.some(label => label.toLowerCase().includes(query));
	}

	function filterActive() {
		return !!(ui.filter.trim() || ui.priorityFilter || ui.blockedOnly);
	}

	// ---------- Header / toolbar ----------

	function renderHeader() {
		const header = el('header', 'board-header');
		const titleRow = el('div', 'board-title-row');
		titleRow.appendChild(el('h1', 'board-title', state.name));
		header.appendChild(titleRow);

		const toolbar = el('div', 'board-toolbar');

		const search = el('span', 'toolbar-search');
		search.appendChild(icon('search'));
		const filterInput = /** @type {HTMLInputElement} */ (el('input', 'filter-input'));
		filterInput.placeholder = 'Filter cards…';
		filterInput.value = ui.filter;
		filterInput.setAttribute('aria-label', 'Filter cards by title, label, id or Jira key');
		filterInput.addEventListener('input', () => {
			ui.filter = filterInput.value;
			saveUi();
			renderColumnsOnly();
		});
		search.appendChild(filterInput);
		toolbar.appendChild(search);

		const prioritySelect = /** @type {HTMLSelectElement} */ (el('select', 'priority-filter'));
		prioritySelect.setAttribute('aria-label', 'Filter by priority');
		for (const [value, label] of [['', 'Any priority'], ['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]) {
			const option = el('option', undefined, label);
			option.setAttribute('value', value);
			prioritySelect.appendChild(option);
		}
		prioritySelect.value = ui.priorityFilter;
		prioritySelect.addEventListener('change', () => {
			ui.priorityFilter = prioritySelect.value;
			saveUi();
			renderColumnsOnly();
		});
		toolbar.appendChild(prioritySelect);

		const blockedButton = el('button', `toolbar-toggle${ui.blockedOnly ? ' active' : ''}`);
		blockedButton.appendChild(icon('circle-slash'));
		blockedButton.appendChild(el('span', undefined, 'Blocked'));
		blockedButton.setAttribute('aria-label', 'Show blocked cards only');
		blockedButton.setAttribute('aria-pressed', String(ui.blockedOnly));
		blockedButton.addEventListener('click', () => {
			ui.blockedOnly = !ui.blockedOnly;
			saveUi();
			render();
		});
		toolbar.appendChild(blockedButton);

		if (filterActive()) {
			const total = allCards().length;
			const matched = allCards().filter(matchesFilter).length;
			const count = el('span', 'filter-count', `${matched} of ${total}`);
			const clear = el('button', 'toolbar-toggle');
			clear.appendChild(icon('clear-all'));
			clear.appendChild(el('span', undefined, 'Clear'));
			clear.addEventListener('click', () => {
				ui.filter = '';
				ui.priorityFilter = '';
				ui.blockedOnly = false;
				saveUi();
				render();
			});
			toolbar.appendChild(count);
			toolbar.appendChild(clear);
		}

		header.appendChild(toolbar);
		return header;
	}

	// ---------- Cards ----------

	function metaRow(card) {
		const meta = el('div', 'card-meta');
		if (card.priority) {
			const flag = icon('flag', `priority-${card.priority}`);
			flag.title = `Priority: ${card.priority}`;
			meta.appendChild(flag);
		}
		if (card.jira) {
			const chip = el('span', 'card-jira', card.jira);
			chip.title = 'Open in Jira';
			chip.addEventListener('click', e => {
				e.stopPropagation();
				vscode.postMessage({ type: 'openJira', key: card.jira });
			});
			meta.appendChild(chip);
		}
		if (card.blocked) {
			const blocked = icon('circle-slash', 'meta-blocked');
			blocked.title = 'Blocked by an unfinished card';
			meta.appendChild(blocked);
		}
		if (card.agentStatus === 'running') {
			const spin = icon('sync', 'codicon-modifier-spin meta-agent-running');
			spin.title = 'An agent is working on this card';
			meta.appendChild(spin);
		} else if (card.agentStatus === 'failed') {
			const err = icon('error', 'meta-agent-failed');
			err.title = 'The last agent run failed — see the handoff note';
			meta.appendChild(err);
		}

		const linkCount = card.links ? card.links.length : 0;
		const sessionCount = card.sessions ? card.sessions.length : 0;
		if (linkCount || card.handoffCount || sessionCount) {
			const activity = el('span', 'card-activity');
			const parts = [];
			if (linkCount) {
				activity.appendChild(icon('link'));
				activity.appendChild(el('span', undefined, String(linkCount)));
				parts.push(`${linkCount} link${linkCount === 1 ? '' : 's'}`);
			}
			if (card.handoffCount) {
				activity.appendChild(icon('comment'));
				activity.appendChild(el('span', undefined, String(card.handoffCount)));
				parts.push(`${card.handoffCount} handoff note${card.handoffCount === 1 ? '' : 's'}`);
			}
			if (sessionCount) {
				activity.appendChild(icon('vm'));
				activity.appendChild(el('span', undefined, String(sessionCount)));
				parts.push(`${sessionCount} agent session${sessionCount === 1 ? '' : 's'}`);
			}
			activity.title = parts.join(' · ');
			meta.appendChild(activity);
		}
		return meta.childNodes.length ? meta : undefined;
	}

	function labelRow(card) {
		if (!card.labels.length) {
			return undefined;
		}
		const row = el('div', 'card-labels');
		const shown = card.labels.slice(0, 2);
		for (const label of shown) {
			row.appendChild(el('span', 'card-label', label));
		}
		if (card.labels.length > 2) {
			const more = el('span', 'card-label card-label-more', `+${card.labels.length - 2}`);
			more.title = card.labels.join(', ');
			row.appendChild(more);
		}
		return row;
	}

	function renderCard(card) {
		const cardEl = el('article', 'card');
		cardEl.tabIndex = 0;
		cardEl.draggable = true;
		cardEl.dataset.cardId = card.id;
		cardEl.setAttribute('aria-label', card.title);
		cardEl.appendChild(el('div', 'card-title', card.title));
		const meta = metaRow(card);
		if (meta) {
			cardEl.appendChild(meta);
		}
		const labels = labelRow(card);
		if (labels) {
			cardEl.appendChild(labels);
		}

		cardEl.addEventListener('click', e => {
			if (/** @type {HTMLElement} */ (e.target).closest('.card-jira')) {
				return;
			}
			openDrawer(card.id);
		});
		cardEl.addEventListener('dblclick', () => vscode.postMessage({ type: 'openCard', fileName: card.fileName }));
		cardEl.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				openDrawer(card.id);
			}
		});
		cardEl.addEventListener('contextmenu', e => {
			e.preventDefault();
			openContextMenu(card, e.clientX, e.clientY);
		});
		cardEl.addEventListener('dragstart', e => {
			cardEl.classList.add('dragging');
			e.dataTransfer.setData('text/plain', card.id);
			e.dataTransfer.effectAllowed = 'move';
		});
		cardEl.addEventListener('dragend', () => cardEl.classList.remove('dragging'));
		return cardEl;
	}

	// ---------- Columns ----------

	function dropIndex(cardsEl, clientY) {
		const cards = Array.from(cardsEl.querySelectorAll('.card:not(.dragging)'));
		for (let i = 0; i < cards.length; i++) {
			const rect = cards[i].getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) {
				return i;
			}
		}
		return cards.length;
	}

	function inlineInput(placeholder, onSubmit) {
		const input = /** @type {HTMLInputElement} */ (el('input', 'inline-input'));
		input.placeholder = placeholder;
		input.addEventListener('keydown', e => {
			if (e.key === 'Enter' && input.value.trim()) {
				onSubmit(input.value.trim());
				input.remove();
			} else if (e.key === 'Escape') {
				input.remove();
			}
		});
		input.addEventListener('blur', () => input.remove());
		return input;
	}

	function renderColumn(column) {
		const columnEl = el('section', 'column');
		columnEl.dataset.columnId = column.id;
		const collapsed = !!ui.collapsed[column.id];
		if (collapsed) {
			columnEl.classList.add('collapsed');
		}

		const visible = column.cards.filter(matchesFilter);
		const columnHeader = el('div', 'column-header');
		const chevron = el('button', 'column-chevron');
		chevron.appendChild(icon(collapsed ? 'chevron-right' : 'chevron-down'));
		chevron.setAttribute('aria-label', collapsed ? `Expand ${column.title}` : `Collapse ${column.title}`);
		chevron.addEventListener('click', () => {
			ui.collapsed[column.id] = !collapsed;
			saveUi();
			render();
		});
		columnHeader.appendChild(chevron);
		columnHeader.appendChild(el('span', 'column-title', column.title));
		const countText = filterActive() && visible.length !== column.cards.length
			? `${visible.length}/${column.cards.length}` : String(column.cards.length);
		const count = el('span', `column-count${column.cards.length > 100 ? ' heavy' : ''}`, countText);
		columnHeader.appendChild(count);
		columnEl.appendChild(columnHeader);

		if (!collapsed) {
			const cardsEl = el('div', 'cards');
			const cap = RENDER_CAP + (ui.extraShown[column.id] || 0);
			for (const card of visible.slice(0, cap)) {
				cardsEl.appendChild(renderCard(card));
			}
			columnEl.appendChild(cardsEl);

			if (visible.length > cap) {
				const remaining = visible.length - cap;
				const more = el('button', 'show-more', `Show ${Math.min(remaining, RENDER_CAP)} more (${remaining} hidden)`);
				more.addEventListener('click', () => {
					ui.extraShown[column.id] = (ui.extraShown[column.id] || 0) + RENDER_CAP;
					saveUi();
					render();
				});
				columnEl.appendChild(more);
			}

			const addButton = el('button', 'add-card');
			addButton.appendChild(icon('add'));
			addButton.appendChild(el('span', undefined, 'Add Card'));
			addButton.addEventListener('click', () => {
				const input = inlineInput('Card title…', title => {
					vscode.postMessage({ type: 'createCard', column: column.id, title });
				});
				columnEl.insertBefore(input, addButton);
				input.focus();
			});
			columnEl.appendChild(addButton);
		}

		columnEl.addEventListener('dragover', e => {
			e.preventDefault();
			e.dataTransfer.dropEffect = 'move';
			columnEl.classList.add('drop-target');
		});
		columnEl.addEventListener('dragleave', () => columnEl.classList.remove('drop-target'));
		columnEl.addEventListener('drop', e => {
			e.preventDefault();
			columnEl.classList.remove('drop-target');
			const cardId = e.dataTransfer.getData('text/plain');
			if (cardId) {
				const cardsEl = columnEl.querySelector('.cards');
				vscode.postMessage({ type: 'moveCard', cardId, toColumn: column.id, toIndex: cardsEl ? dropIndex(cardsEl, e.clientY) : 0 });
			}
		});
		return columnEl;
	}

	// ---------- Context menu ----------

	let menuEl;

	function closeContextMenu() {
		if (menuEl) {
			menuEl.remove();
			menuEl = undefined;
		}
	}

	function menuItem(label, iconName, onClick, submenuArrow) {
		const item = el('div', 'menu-item');
		item.appendChild(icon(iconName));
		item.appendChild(el('span', 'menu-label', label));
		if (submenuArrow) {
			item.appendChild(icon('chevron-right', 'menu-arrow'));
		}
		if (onClick) {
			item.addEventListener('click', () => {
				closeContextMenu();
				onClick();
			});
		}
		return item;
	}

	function submenu(parentItem, build) {
		const sub = el('div', 'context-menu submenu');
		build(sub);
		parentItem.appendChild(sub);
		parentItem.classList.add('has-submenu');
	}

	function openContextMenu(card, x, y) {
		closeContextMenu();
		closeDrawer();
		menuEl = el('div', 'context-menu');

		const moveItem = menuItem('Move to', 'arrow-right', undefined, true);
		submenu(moveItem, sub => {
			for (const column of state.columns) {
				if (column.id !== card.column) {
					sub.appendChild(menuItem(column.title, 'circle-small', () =>
						vscode.postMessage({ type: 'moveCard', cardId: card.id, toColumn: column.id, toIndex: Number.MAX_SAFE_INTEGER })));
				}
			}
		});
		menuEl.appendChild(moveItem);

		const priorityItem = menuItem('Set priority', 'flag', undefined, true);
		submenu(priorityItem, sub => {
			for (const priority of ['urgent', 'high', 'medium', 'low']) {
				sub.appendChild(menuItem(priority, 'flag', () =>
					vscode.postMessage({ type: 'updateCard', cardId: card.id, priority })));
			}
			sub.appendChild(menuItem('Clear', 'close', () =>
				vscode.postMessage({ type: 'updateCard', cardId: card.id, priority: '' })));
		});
		menuEl.appendChild(priorityItem);

		menuEl.appendChild(menuItem('Run Agent', 'play', () => vscode.postMessage({ type: 'runAgent', cardId: card.id })));
		menuEl.appendChild(menuItem('Decompose (DM)', 'rocket', () => vscode.postMessage({ type: 'decompose', cardId: card.id })));
		if (card.jira) {
			menuEl.appendChild(menuItem('Open in Jira', 'link-external', () => vscode.postMessage({ type: 'openJira', key: card.jira })));
		} else {
			menuEl.appendChild(menuItem('Push to Jira', 'cloud-upload', () => vscode.postMessage({ type: 'pushJira', cardId: card.id })));
		}
		menuEl.appendChild(menuItem('Open card file', 'go-to-file', () => vscode.postMessage({ type: 'openCard', fileName: card.fileName })));
		menuEl.appendChild(menuItem('Copy id', 'copy', () => vscode.postMessage({ type: 'copyText', text: card.id })));

		document.body.appendChild(menuEl);
		const rect = menuEl.getBoundingClientRect();
		menuEl.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
		menuEl.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
	}

	document.addEventListener('click', e => {
		if (menuEl && !menuEl.contains(/** @type {Node} */(e.target))) {
			closeContextMenu();
		}
	});

	// ---------- Drawer ----------

	let drawerEl;

	function closeDrawer() {
		ui.drawerCardId = undefined;
		saveUi();
		if (drawerEl) {
			drawerEl.remove();
			drawerEl = undefined;
		}
		document.body.classList.remove('drawer-open');
	}

	function escapeHtml(text) {
		return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	/** Tiny sanitized markdown: headings, bold, italic, inline/blocks of code, lists, links. */
	function miniMarkdown(markdown) {
		let html = escapeHtml(markdown);
		html = html.replace(/```([\s\S]*?)```/g, (_m, code) => `<pre>${code}</pre>`);
		html = html.replace(/^###+\s+(.*)$/gm, '<h4>$1</h4>');
		html = html.replace(/^##\s+(.*)$/gm, '<h3>$1</h3>');
		html = html.replace(/^#\s+(.*)$/gm, '<h2>$1</h2>');
		html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
		html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
		html = html.replace(/^\s*[-*]\s+(.*)$/gm, '<li>$1</li>');
		html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>');
		html = html.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="#" data-url="$2">$1</a>');
		html = html.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, ' ');
		return html;
	}

	function parseHandoffs(body) {
		const match = /^##\s+Handoffs\s*$/m.exec(body);
		if (!match) {
			return { rest: body, entries: [] };
		}
		const start = match.index;
		const section = body.slice(start);
		const entries = section.split(/^###\s+/m).slice(1).map(chunk => {
			const [head, ...lines] = chunk.split('\n');
			return { head: head.trim(), body: lines.join('\n').trim() };
		});
		return { rest: body.slice(0, start), entries: entries.reverse() };
	}

	function drawerRow(labelText, node) {
		const row = el('div', 'drawer-row');
		row.appendChild(el('span', 'drawer-row-label', labelText));
		row.appendChild(node);
		return row;
	}

	function actionButton(label, iconName, message) {
		const button = el('button', 'drawer-action');
		button.appendChild(icon(iconName));
		button.appendChild(el('span', undefined, label));
		button.addEventListener('click', () => vscode.postMessage(message));
		return button;
	}

	function openDrawer(cardId) {
		const card = cardById(cardId);
		if (!card) {
			return;
		}
		closeDrawer();
		closeContextMenu();
		ui.drawerCardId = cardId;
		saveUi();

		drawerEl = el('aside', 'drawer');
		drawerEl.setAttribute('role', 'dialog');
		drawerEl.setAttribute('aria-label', `Card ${card.title}`);

		const head = el('div', 'drawer-head');
		const titleInput = /** @type {HTMLInputElement} */ (el('input', 'drawer-title'));
		titleInput.value = card.title;
		titleInput.setAttribute('aria-label', 'Card title');
		const commitTitle = () => {
			if (titleInput.value.trim() && titleInput.value.trim() !== card.title) {
				vscode.postMessage({ type: 'updateCard', cardId: card.id, title: titleInput.value.trim() });
			}
		};
		titleInput.addEventListener('blur', commitTitle);
		titleInput.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				commitTitle();
				titleInput.blur();
			}
		});
		head.appendChild(titleInput);
		const close = el('button', 'drawer-close');
		close.appendChild(icon('close'));
		close.setAttribute('aria-label', 'Close');
		close.addEventListener('click', closeDrawer);
		head.appendChild(close);
		drawerEl.appendChild(head);

		drawerEl.appendChild(el('div', 'drawer-sub', `${card.id} · ${card.column}${card.blocked ? ' · blocked' : ''}`));

		const prioritySelect = /** @type {HTMLSelectElement} */ (el('select', 'drawer-select'));
		for (const [value, label] of [['', 'No priority'], ['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]) {
			const option = el('option', undefined, label);
			option.setAttribute('value', value);
			prioritySelect.appendChild(option);
		}
		prioritySelect.value = card.priority || '';
		prioritySelect.addEventListener('change', () =>
			vscode.postMessage({ type: 'updateCard', cardId: card.id, priority: prioritySelect.value }));
		drawerEl.appendChild(drawerRow('Priority', prioritySelect));

		const labelsInput = /** @type {HTMLInputElement} */ (el('input', 'drawer-input'));
		labelsInput.value = card.labels.join(', ');
		labelsInput.placeholder = 'comma, separated';
		labelsInput.setAttribute('aria-label', 'Labels');
		labelsInput.addEventListener('blur', () => {
			const labels = labelsInput.value.split(',').map(label => label.trim()).filter(Boolean);
			if (labels.join(',') !== card.labels.join(',')) {
				vscode.postMessage({ type: 'updateCard', cardId: card.id, labels });
			}
		});
		drawerEl.appendChild(drawerRow('Labels', labelsInput));

		if (card.jira) {
			const jiraLink = el('a', 'drawer-jira', card.jira);
			jiraLink.href = '#';
			jiraLink.addEventListener('click', e => {
				e.preventDefault();
				vscode.postMessage({ type: 'openJira', key: card.jira });
			});
			drawerEl.appendChild(drawerRow('Jira', jiraLink));
		}

		if (card.links && card.links.length) {
			const linksEl = el('div', 'drawer-links');
			for (const link of card.links) {
				const target = cardById(link.target);
				const row = el('button', 'drawer-link');
				row.appendChild(icon(link.type === 'blocking' ? 'circle-slash' : link.type === 'parent' ? 'type-hierarchy' : 'link'));
				row.appendChild(el('span', undefined, `${link.type}: ${target ? target.title : link.target}`));
				if (target) {
					row.addEventListener('click', () => {
						closeDrawer();
						const targetEl = boardEl.querySelector(`[data-card-id="${link.target}"]`);
						if (targetEl) {
							targetEl.scrollIntoView({ block: 'center' });
							/** @type {HTMLElement} */ (targetEl).focus();
						} else {
							openDrawer(link.target);
						}
					});
				}
				linksEl.appendChild(row);
			}
			drawerEl.appendChild(drawerRow('Links', linksEl));
		}

		const actions = el('div', 'drawer-actions');
		actions.appendChild(actionButton('Run Agent', 'play', { type: 'runAgent', cardId: card.id }));
		actions.appendChild(actionButton('Decompose', 'rocket', { type: 'decompose', cardId: card.id }));
		if (!card.jira) {
			actions.appendChild(actionButton('Push to Jira', 'cloud-upload', { type: 'pushJira', cardId: card.id }));
		}
		actions.appendChild(actionButton('Open File', 'go-to-file', { type: 'openCard', fileName: card.fileName }));
		drawerEl.appendChild(actions);

		const { rest, entries } = parseHandoffs(card.body || '');
		if (rest.trim()) {
			const bodyEl = el('div', 'drawer-body');
			bodyEl.innerHTML = miniMarkdown(rest.trim());
			bodyEl.addEventListener('click', e => {
				const anchor = /** @type {HTMLElement} */ (e.target).closest('a[data-url]');
				if (anchor) {
					e.preventDefault();
					vscode.postMessage({ type: 'openExternal', url: anchor.getAttribute('data-url') });
				}
			});
			drawerEl.appendChild(el('div', 'drawer-section-title', 'Description'));
			drawerEl.appendChild(bodyEl);
		}

		if (entries.length) {
			drawerEl.appendChild(el('div', 'drawer-section-title', `Handoffs (${entries.length})`));
			const timeline = el('div', 'drawer-timeline');
			for (const entry of entries) {
				const item = el('div', 'timeline-entry');
				item.appendChild(el('div', 'timeline-head', entry.head));
				const entryBody = el('div', 'timeline-body');
				entryBody.innerHTML = miniMarkdown(entry.body);
				item.appendChild(entryBody);
				timeline.appendChild(item);
			}
			drawerEl.appendChild(timeline);
		}

		document.body.appendChild(drawerEl);
		document.body.classList.add('drawer-open');
	}

	// ---------- Keyboard navigation ----------

	document.addEventListener('keydown', e => {
		if (e.key === 'Escape') {
			closeContextMenu();
			closeDrawer();
			return;
		}
		const target = /** @type {HTMLElement} */ (e.target);
		if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') {
			return;
		}
		if (e.key === 'f') {
			const filter = boardEl.querySelector('.filter-input');
			if (filter) {
				e.preventDefault();
				/** @type {HTMLElement} */ (filter).focus();
			}
			return;
		}
		if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
			return;
		}
		const focused = document.activeElement && document.activeElement.classList.contains('card') ? document.activeElement : undefined;
		const columns = Array.from(boardEl.querySelectorAll('.column:not(.collapsed)'));
		if (!focused) {
			const first = boardEl.querySelector('.card');
			if (first) {
				/** @type {HTMLElement} */ (first).focus();
				e.preventDefault();
			}
			return;
		}
		const columnEl = focused.closest('.column');
		const cardsInColumn = Array.from(columnEl.querySelectorAll('.card'));
		const cardIndex = cardsInColumn.indexOf(/** @type {Element} */(focused));
		const columnIndex = columns.indexOf(columnEl);
		let next;
		if (e.key === 'ArrowUp') {
			next = cardsInColumn[cardIndex - 1];
		} else if (e.key === 'ArrowDown') {
			next = cardsInColumn[cardIndex + 1];
		} else {
			const neighbour = columns[columnIndex + (e.key === 'ArrowRight' ? 1 : -1)];
			if (neighbour) {
				const neighbourCards = neighbour.querySelectorAll('.card');
				next = neighbourCards[Math.min(cardIndex, neighbourCards.length - 1)];
			}
		}
		if (next) {
			/** @type {HTMLElement} */ (next).focus();
			e.preventDefault();
		}
	});

	// ---------- Render ----------

	function renderColumnsOnly() {
		const existing = boardEl.querySelector('.columns');
		if (existing) {
			existing.replaceWith(buildColumns());
		}
		const count = boardEl.querySelector('.filter-count');
		if (count) {
			const total = allCards().length;
			const matched = allCards().filter(matchesFilter).length;
			count.textContent = `${matched} of ${total}`;
		}
	}

	function buildColumns() {
		const columnsEl = el('div', 'columns');
		for (const column of state.columns) {
			columnsEl.appendChild(renderColumn(column));
		}
		const addColumnButton = el('button', 'add-column');
		addColumnButton.appendChild(icon('add'));
		addColumnButton.appendChild(el('span', undefined, 'Add Column'));
		addColumnButton.addEventListener('click', () => {
			const input = inlineInput('Column title…', title => {
				vscode.postMessage({ type: 'addColumn', title });
			});
			columnsEl.insertBefore(input, addColumnButton);
			input.focus();
		});
		columnsEl.appendChild(addColumnButton);
		return columnsEl;
	}

	function render() {
		closeContextMenu();
		boardEl.textContent = '';
		boardEl.appendChild(renderHeader());
		boardEl.appendChild(buildColumns());
		if (ui.drawerCardId && cardById(ui.drawerCardId)) {
			openDrawer(ui.drawerCardId);
		} else if (drawerEl) {
			closeDrawer();
		}
	}

	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'board') {
			state = message.state;
			render();
		} else if (message.type === 'error') {
			boardEl.textContent = '';
			boardEl.appendChild(el('div', 'board-error', message.message));
		}
	});

	vscode.postMessage({ type: 'ready' });
}());
