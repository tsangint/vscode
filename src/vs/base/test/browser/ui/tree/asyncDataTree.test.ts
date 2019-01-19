/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ITreeNode, ITreeRenderer, IAsyncDataSource } from 'vs/base/browser/ui/tree/tree';
import { AsyncDataTree } from 'vs/base/browser/ui/tree/asyncDataTree';
import { IListVirtualDelegate, IIdentityProvider } from 'vs/base/browser/ui/list/list';
import { hasClass } from 'vs/base/browser/dom';

interface Element {
	id: string;
	children?: Element[];
}

function find(elements: Element[] | undefined, id: string): Element {
	while (elements) {
		for (const element of elements) {
			if (element.id === id) {
				return element;
			}
		}
	}

	throw new Error('element not found');
}

suite('AsyncDataTree', function () {

	test('Collapse state should be preserved across refresh calls', async () => {
		const container = document.createElement('div');
		container.style.width = '200px';
		container.style.height = '200px';

		const delegate = new class implements IListVirtualDelegate<Element> {
			getHeight() { return 20; }
			getTemplateId(element: Element): string { return 'default'; }
		};

		const renderer = new class implements ITreeRenderer<Element, void, HTMLElement> {
			readonly templateId = 'default';
			renderTemplate(container: HTMLElement): HTMLElement {
				return container;
			}
			renderElement(element: ITreeNode<Element, void>, index: number, templateData: HTMLElement): void {
				templateData.textContent = element.element.id;
			}
			disposeTemplate(templateData: HTMLElement): void {
				// noop
			}
		};

		const dataSource = new class implements IAsyncDataSource<Element, Element> {
			hasChildren(element: Element): boolean {
				return !!element.children && element.children.length > 0;
			}
			getChildren(element: Element): Promise<Element[]> {
				return Promise.resolve(element.children || []);
			}
		};

		const identityProvider = new class implements IIdentityProvider<Element> {
			getId(element: Element) {
				return element.id;
			}
		};

		const root: Element = {
			id: 'root',
			children: [{
				id: 'a'
			}]
		};

		const _: (id: string) => Element = find.bind(null, root.children);

		const tree = new AsyncDataTree<Element, Element>(container, delegate, [renderer], dataSource, { identityProvider });
		tree.layout(200);
		assert.equal(container.querySelectorAll('.monaco-list-row').length, 0);

		await tree.setInput(root);
		assert.equal(container.querySelectorAll('.monaco-list-row').length, 1);
		let twistie = container.querySelector('.monaco-list-row:first-child .monaco-tl-twistie') as HTMLElement;
		assert(!hasClass(twistie, 'collapsible'));
		assert(!hasClass(twistie, 'collapsed'));

		_('a').children = [
			{ id: 'aa' },
			{ id: 'ab' },
			{ id: 'ac' }
		];

		await tree.updateChildren(root);
		assert.equal(container.querySelectorAll('.monaco-list-row').length, 1);

		await tree.expand(_('a'));
		assert.equal(container.querySelectorAll('.monaco-list-row').length, 4);

		_('a').children = [];
		await tree.updateChildren(root);
		assert.equal(container.querySelectorAll('.monaco-list-row').length, 1);
	});
});