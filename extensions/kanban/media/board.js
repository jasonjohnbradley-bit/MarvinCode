/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// @ts-check
(function () {
	// @ts-ignore
	const vscode = acquireVsCodeApi();
	const boardEl = /** @type {HTMLElement} */ (document.getElementById('board'));

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

	/** Index the dragged card would take if dropped at clientY in this cards container. */
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

	function renderCard(card) {
		const cardEl = el('article', 'card');
		cardEl.tabIndex = 0;
		cardEl.draggable = true;
		cardEl.dataset.cardId = card.id;
		cardEl.appendChild(el('div', 'card-title', card.title));
		if (card.labels.length || (card.sessions && card.sessions.length)) {
			const labelsEl = el('div', 'card-labels');
			for (const label of card.labels) {
				labelsEl.appendChild(el('span', 'card-label', label));
			}
			if (card.sessions && card.sessions.length) {
				// allow-any-unicode-next-line
				const chip = el('span', 'card-label card-sessions', `⛓ ${card.sessions.length} session${card.sessions.length === 1 ? '' : 's'}`);
				chip.title = 'Agent sessions that touched this card:\n' + card.sessions.join('\n');
				labelsEl.appendChild(chip);
			}
			cardEl.appendChild(labelsEl);
		}
		const open = () => vscode.postMessage({ type: 'openCard', fileName: card.fileName });
		cardEl.addEventListener('dblclick', open);
		cardEl.addEventListener('keydown', e => {
			if (e.key === 'Enter') {
				open();
			}
		});
		cardEl.addEventListener('dragstart', e => {
			cardEl.classList.add('dragging');
			e.dataTransfer.setData('text/plain', card.id);
			e.dataTransfer.effectAllowed = 'move';
		});
		cardEl.addEventListener('dragend', () => cardEl.classList.remove('dragging'));
		return cardEl;
	}

	function renderColumn(column) {
		const columnEl = el('section', 'column');
		const columnHeader = el('div', 'column-header');
		columnHeader.appendChild(el('span', 'column-title', column.title));
		columnHeader.appendChild(el('span', 'column-count', String(column.cards.length)));
		columnEl.appendChild(columnHeader);

		const cardsEl = el('div', 'cards');
		for (const card of column.cards) {
			cardsEl.appendChild(renderCard(card));
		}
		columnEl.appendChild(cardsEl);

		const addButton = el('button', 'add-card', '+ Add Card');
		addButton.addEventListener('click', () => {
			const input = inlineInput('Card title…', title => {
				vscode.postMessage({ type: 'createCard', column: column.id, title });
			});
			columnEl.insertBefore(input, addButton);
			input.focus();
		});
		columnEl.appendChild(addButton);

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
				vscode.postMessage({ type: 'moveCard', cardId, toColumn: column.id, toIndex: dropIndex(cardsEl, e.clientY) });
			}
		});
		return columnEl;
	}

	function render(state) {
		boardEl.textContent = '';
		const header = el('header', 'board-header');
		header.appendChild(el('h1', 'board-title', state.name));
		boardEl.appendChild(header);

		const columnsEl = el('div', 'columns');
		for (const column of state.columns) {
			columnsEl.appendChild(renderColumn(column));
		}

		const addColumnButton = el('button', 'add-column', '+ Add Column');
		addColumnButton.addEventListener('click', () => {
			const input = inlineInput('Column title…', title => {
				vscode.postMessage({ type: 'addColumn', title });
			});
			columnsEl.insertBefore(input, addColumnButton);
			input.focus();
		});
		columnsEl.appendChild(addColumnButton);
		boardEl.appendChild(columnsEl);
	}

	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'board') {
			render(message.state);
		} else if (message.type === 'error') {
			boardEl.textContent = '';
			boardEl.appendChild(el('div', 'board-error', message.message));
		}
	});

	vscode.postMessage({ type: 'ready' });
}());
