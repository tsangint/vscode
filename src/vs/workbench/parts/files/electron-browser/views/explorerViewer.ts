/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IAccessibilityProvider } from 'vs/base/browser/ui/list/listWidget';
import * as DOM from 'vs/base/browser/dom';
import * as glob from 'vs/base/common/glob';
import { IListVirtualDelegate, ListDragOverEffect } from 'vs/base/browser/ui/list/list';
import { IProgressService } from 'vs/platform/progress/common/progress';
import { INotificationService } from 'vs/platform/notification/common/notification';
import { IFileService, FileKind, IFileStat, FileOperationError, FileOperationResult } from 'vs/platform/files/common/files';
import { IPartService } from 'vs/workbench/services/part/common/partService';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IDisposable, Disposable, dispose, toDisposable } from 'vs/base/common/lifecycle';
import { KeyCode } from 'vs/base/common/keyCodes';
import { IFileLabelOptions, IResourceLabel, ResourceLabels } from 'vs/workbench/browser/labels';
import { ITreeRenderer, ITreeNode, ITreeFilter, TreeVisibility, TreeFilterResult, IAsyncDataSource, ITreeSorter, ITreeDragAndDrop, ITreeDragOverReaction, TreeDragOverBubble } from 'vs/base/browser/ui/tree/tree';
import { IContextViewService } from 'vs/platform/contextview/browser/contextView';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { IConfigurationService, ConfigurationTarget } from 'vs/platform/configuration/common/configuration';
import { IFilesConfiguration, IExplorerService, IEditableData } from 'vs/workbench/parts/files/common/files';
import { dirname, joinPath, isEqualOrParent, basename, hasToIgnoreCase, distinctParents } from 'vs/base/common/resources';
import { InputBox, MessageType } from 'vs/base/browser/ui/inputbox/inputBox';
import { localize } from 'vs/nls';
import { attachInputBoxStyler } from 'vs/platform/theme/common/styler';
import { once } from 'vs/base/common/functional';
import { IKeyboardEvent } from 'vs/base/browser/keyboardEvent';
import { normalize } from 'vs/base/common/paths';
import { equals, deepClone } from 'vs/base/common/objects';
import * as path from 'path';
import { ExplorerItem } from 'vs/workbench/parts/files/common/explorerModel';
import { compareFileExtensions, compareFileNames } from 'vs/base/common/comparers';
import { fillResourceDataTransfers, CodeDataTransfers, extractResources } from 'vs/workbench/browser/dnd';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IDragAndDropData, DataTransfers } from 'vs/base/browser/dnd';
import { Schemas } from 'vs/base/common/network';
import { DesktopDragAndDropData, ExternalElementsDragAndDropData, ElementsDragAndDropData } from 'vs/base/browser/ui/list/listView';
import { isMacintosh, isLinux } from 'vs/base/common/platform';
import { IDialogService, IConfirmationResult, IConfirmation, getConfirmMessage } from 'vs/platform/dialogs/common/dialogs';
import { ITextFileService, ITextFileOperationResult } from 'vs/workbench/services/textfile/common/textfiles';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { IWorkspaceEditingService } from 'vs/workbench/services/workspace/common/workspaceEditing';
import { URI } from 'vs/base/common/uri';
import { ITask, sequence } from 'vs/base/common/async';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IWorkspaceFolderCreationData } from 'vs/platform/workspaces/common/workspaces';
import { findValidPasteFileTarget } from 'vs/workbench/parts/files/electron-browser/fileActions';

export class ExplorerDelegate implements IListVirtualDelegate<ExplorerItem> {

	private static readonly ITEM_HEIGHT = 22;

	getHeight(element: ExplorerItem): number {
		return ExplorerDelegate.ITEM_HEIGHT;
	}

	getTemplateId(element: ExplorerItem): string {
		return FilesRenderer.ID;
	}
}

export class ExplorerDataSource implements IAsyncDataSource<ExplorerItem | ExplorerItem[], ExplorerItem> {

	constructor(
		@IProgressService private progressService: IProgressService,
		@INotificationService private notificationService: INotificationService,
		@IPartService private partService: IPartService,
		@IFileService private fileService: IFileService
	) { }

	hasChildren(element: ExplorerItem | ExplorerItem[]): boolean {
		return Array.isArray(element) || element.isDirectory;
	}

	getChildren(element: ExplorerItem | ExplorerItem[]): Promise<ExplorerItem[]> {
		if (Array.isArray(element)) {
			return Promise.resolve(element);
		}

		const promise = element.fetchChildren(this.fileService).then(undefined, e => {
			// Do not show error for roots since we already use an explorer decoration to notify user
			if (!(element instanceof ExplorerItem && element.isRoot)) {
				this.notificationService.error(e);
			}

			return []; // we could not resolve any children because of an error
		});

		this.progressService.showWhile(promise, this.partService.isRestored() ? 800 : 3200 /* less ugly initial startup */);
		return promise;
	}
}

export interface IFileTemplateData {
	elementDisposable: IDisposable;
	label: IResourceLabel;
	container: HTMLElement;
}

export class FilesRenderer implements ITreeRenderer<ExplorerItem, void, IFileTemplateData>, IDisposable {
	static readonly ID = 'file';

	private config: IFilesConfiguration;
	private configListener: IDisposable;

	constructor(
		private labels: ResourceLabels,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IThemeService private readonly themeService: IThemeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExplorerService private readonly explorerService: IExplorerService
	) {
		this.config = this.configurationService.getValue<IFilesConfiguration>();
		this.configListener = this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('explorer')) {
				this.config = this.configurationService.getValue();
			}
		});
	}

	get templateId(): string {
		return FilesRenderer.ID;
	}

	renderTemplate(container: HTMLElement): IFileTemplateData {
		const elementDisposable = Disposable.None;
		const label = this.labels.create(container);

		return { elementDisposable, label, container };
	}

	renderElement(element: ITreeNode<ExplorerItem, void>, index: number, templateData: IFileTemplateData): void {
		templateData.elementDisposable.dispose();
		const stat = element.element;
		const editableData = this.explorerService.getEditableData(stat);

		// File Label
		if (!editableData) {
			templateData.label.element.style.display = 'flex';
			const extraClasses = ['explorer-item'];
			templateData.label.setFile(stat.resource, {
				hidePath: true,
				fileKind: stat.isRoot ? FileKind.ROOT_FOLDER : stat.isDirectory ? FileKind.FOLDER : FileKind.FILE,
				extraClasses,
				fileDecorations: this.config.explorer.decorations
			});

			templateData.elementDisposable = templateData.label.onDidRender(() => {
				// todo@isidor horizontal scrolling
				// this.tree.updateWidth(stat);
			});
		}

		// Input Box
		else {
			templateData.label.element.style.display = 'none';
			templateData.elementDisposable = this.renderInputBox(templateData.container, stat, editableData);
		}
	}

	private renderInputBox(container: HTMLElement, stat: ExplorerItem, editableData: IEditableData): IDisposable {

		// Use a file label only for the icon next to the input box
		const label = this.labels.create(container);
		const extraClasses = ['explorer-item', 'explorer-item-edited'];
		const fileKind = stat.isRoot ? FileKind.ROOT_FOLDER : stat.isDirectory ? FileKind.FOLDER : FileKind.FILE;
		const labelOptions: IFileLabelOptions = { hidePath: true, hideLabel: true, fileKind, extraClasses };

		const parent = stat.name ? dirname(stat.resource) : stat.resource;
		const value = stat.name || '';

		label.setFile(joinPath(parent, value || ' '), labelOptions); // Use icon for ' ' if name is empty.

		// Input field for name
		const inputBox = new InputBox(label.element, this.contextViewService, {
			validationOptions: {
				validation: (value) => {
					const content = editableData.validationMessage(value);
					if (!content) {
						return null;
					}

					return {
						content,
						formatContent: true,
						type: MessageType.ERROR
					};
				}
			},
			ariaLabel: localize('fileInputAriaLabel', "Type file name. Press Enter to confirm or Escape to cancel.")
		});
		const styler = attachInputBoxStyler(inputBox, this.themeService);

		inputBox.onDidChange(value => {
			label.setFile(joinPath(parent, value || ' '), labelOptions); // update label icon while typing!
		});

		const lastDot = value.lastIndexOf('.');

		inputBox.value = value;
		inputBox.select({ start: 0, end: lastDot > 0 && !stat.isDirectory ? lastDot : value.length });
		inputBox.focus();

		const done = once(async (success: boolean, blur: boolean) => {
			label.element.style.display = 'none';
			const value = inputBox.value;
			dispose(toDispose);
			container.removeChild(label.element);
			editableData.onFinish(value, success);
		});

		// It can happen that the tree re-renders this node. When that happens,
		// we're gonna get a blur event first and only after an element disposable.
		// Because of that, we should setTimeout the blur handler to differentiate
		// between the blur happening because of a unrender or because of a user action.
		let ignoreBlur = false;

		const toDispose = [
			inputBox,
			DOM.addStandardDisposableListener(inputBox.inputElement, DOM.EventType.KEY_DOWN, (e: IKeyboardEvent) => {
				if (e.equals(KeyCode.Enter)) {
					if (inputBox.validate()) {
						done(true, false);
					}
				} else if (e.equals(KeyCode.Escape)) {
					done(false, false);
				}
			}),
			DOM.addDisposableListener(inputBox.inputElement, DOM.EventType.BLUR, () => {
				setTimeout(() => {
					if (!ignoreBlur) {
						done(inputBox.isInputValid(), true);
					}
				}, 0);
			}),
			label,
			styler
		];

		return toDisposable(() => ignoreBlur = true);
	}

	disposeElement?(element: ITreeNode<ExplorerItem, void>, index: number, templateData: IFileTemplateData): void {
		// noop
	}

	disposeTemplate(templateData: IFileTemplateData): void {
		templateData.elementDisposable.dispose();
		templateData.label.dispose();
	}

	dispose(): void {
		this.configListener.dispose();
	}
}

export class ExplorerAccessibilityProvider implements IAccessibilityProvider<ExplorerItem> {
	getAriaLabel(element: ExplorerItem): string {
		return element.name;
	}
}

interface CachedParsedExpression {
	original: glob.IExpression;
	parsed: glob.ParsedExpression;
}

export class FilesFilter implements ITreeFilter<ExplorerItem, void> {
	private hiddenExpressionPerRoot: Map<string, CachedParsedExpression>;
	private workspaceFolderChangeListener: IDisposable;

	constructor(
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IExplorerService private readonly explorerService: IExplorerService
	) {
		this.hiddenExpressionPerRoot = new Map<string, CachedParsedExpression>();
		this.workspaceFolderChangeListener = this.contextService.onDidChangeWorkspaceFolders(() => this.updateConfiguration());
	}

	updateConfiguration(): boolean {
		let needsRefresh = false;
		this.contextService.getWorkspace().folders.forEach(folder => {
			const configuration = this.configurationService.getValue<IFilesConfiguration>({ resource: folder.uri });
			const excludesConfig: glob.IExpression = (configuration && configuration.files && configuration.files.exclude) || Object.create(null);

			if (!needsRefresh) {
				const cached = this.hiddenExpressionPerRoot.get(folder.uri.toString());
				needsRefresh = !cached || !equals(cached.original, excludesConfig);
			}

			const excludesConfigCopy = deepClone(excludesConfig); // do not keep the config, as it gets mutated under our hoods

			this.hiddenExpressionPerRoot.set(folder.uri.toString(), { original: excludesConfigCopy, parsed: glob.parse(excludesConfigCopy) } as CachedParsedExpression);
		});

		return needsRefresh;
	}

	filter(stat: ExplorerItem, parentVisibility: TreeVisibility): TreeFilterResult<void> {
		if (parentVisibility === TreeVisibility.Hidden) {
			return false;
		}
		if (this.explorerService.getEditableData(stat) || stat.isRoot) {
			return true; // always visible
		}

		// Hide those that match Hidden Patterns
		const cached = this.hiddenExpressionPerRoot.get(stat.root.resource.toString());
		if (cached && cached.parsed(normalize(path.relative(stat.root.resource.path, stat.resource.path), true), stat.name, name => !!stat.parent.getChild(name))) {
			return false; // hidden through pattern
		}

		return true;
	}

	public dispose(): void {
		this.workspaceFolderChangeListener = dispose(this.workspaceFolderChangeListener);
	}
}

// // Explorer Sorter
export class FileSorter implements ITreeSorter<ExplorerItem> {

	constructor(
		@IExplorerService private readonly explorerService: IExplorerService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService
	) { }

	public compare(statA: ExplorerItem, statB: ExplorerItem): number {
		// Do not sort roots
		if (statA.isRoot) {
			if (statB.isRoot) {
				return this.contextService.getWorkspaceFolder(statA.resource).index - this.contextService.getWorkspaceFolder(statB.resource).index;
			}

			return -1;
		}

		if (statB.isRoot) {
			return 1;
		}

		const sortOrder = this.explorerService.sortOrder;

		// Sort Directories
		switch (sortOrder) {
			case 'type':
				if (statA.isDirectory && !statB.isDirectory) {
					return -1;
				}

				if (statB.isDirectory && !statA.isDirectory) {
					return 1;
				}

				if (statA.isDirectory && statB.isDirectory) {
					return compareFileNames(statA.name, statB.name);
				}

				break;

			case 'filesFirst':
				if (statA.isDirectory && !statB.isDirectory) {
					return 1;
				}

				if (statB.isDirectory && !statA.isDirectory) {
					return -1;
				}

				break;

			case 'mixed':
				break; // not sorting when "mixed" is on

			default: /* 'default', 'modified' */
				if (statA.isDirectory && !statB.isDirectory) {
					return -1;
				}

				if (statB.isDirectory && !statA.isDirectory) {
					return 1;
				}

				break;
		}

		// Sort Files
		switch (sortOrder) {
			case 'type':
				return compareFileExtensions(statA.name, statB.name);

			case 'modified':
				if (statA.mtime !== statB.mtime) {
					return statA.mtime < statB.mtime ? 1 : -1;
				}

				return compareFileNames(statA.name, statB.name);

			default: /* 'default', 'mixed', 'filesFirst' */
				return compareFileNames(statA.name, statB.name);
		}
	}
}

export class FileDragAndDrop implements ITreeDragAndDrop<ExplorerItem> {
	private static readonly CONFIRM_DND_SETTING_KEY = 'explorer.confirmDragAndDrop';

	private toDispose: IDisposable[];
	private dropEnabled: boolean;

	constructor(
		@INotificationService private notificationService: INotificationService,
		@IExplorerService private explorerService: IExplorerService,
		@IEditorService private editorService: IEditorService,
		@IDialogService private dialogService: IDialogService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IFileService private fileService: IFileService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@ITextFileService private textFileService: ITextFileService,
		@IWindowService private windowService: IWindowService,
		@IWorkspaceEditingService private workspaceEditingService: IWorkspaceEditingService
	) {
		this.toDispose = [];

		const updateDropEnablement = () => {
			this.dropEnabled = this.configurationService.getValue('explorer.enableDragAndDrop');
		};
		updateDropEnablement();
		this.toDispose.push(this.configurationService.onDidChangeConfiguration((e) => updateDropEnablement()));
	}

	onDragOver(data: IDragAndDropData, target: ExplorerItem, targetIndex: number, originalEvent: DragEvent): boolean | ITreeDragOverReaction {
		if (!this.dropEnabled) {
			return false;
		}

		const isCopy = originalEvent && ((originalEvent.ctrlKey && !isMacintosh) || (originalEvent.altKey && isMacintosh));
		const fromDesktop = data instanceof DesktopDragAndDropData;

		// Desktop DND
		if (fromDesktop) {
			const types = originalEvent.dataTransfer.types;
			const typesArray: string[] = [];
			for (let i = 0; i < types.length; i++) {
				typesArray.push(types[i].toLowerCase()); // somehow the types are lowercase
			}

			if (typesArray.indexOf(DataTransfers.FILES.toLowerCase()) === -1 && typesArray.indexOf(CodeDataTransfers.FILES.toLowerCase()) === -1) {
				return false;
			}
		}

		// Other-Tree DND
		else if (data instanceof ExternalElementsDragAndDropData) {
			return false;
		}

		// In-Explorer DND
		else {
			const items = (data as ElementsDragAndDropData<ExplorerItem>).elements;

			if (!target) {
				// Droping onto the empty area. Do not accept if items dragged are already children of the root
				if (items.every(i => i.parent.isRoot)) {
					return false;
				}

				return { accept: true, bubble: TreeDragOverBubble.Down, autoExpand: false };
			}

			if (!Array.isArray(items)) {
				return false;
			}

			if (items.some((source) => {
				if (source.isRoot && target instanceof ExplorerItem && !target.isRoot) {
					return true; // Root folder can not be moved to a non root file stat.
				}

				if (source.resource.toString() === target.resource.toString()) {
					return true; // Can not move anything onto itself
				}

				if (source.isRoot && target instanceof ExplorerItem && target.isRoot) {
					// Disable moving workspace roots in one another
					return false;
				}

				if (!isCopy && dirname(source.resource).toString() === target.resource.toString()) {
					return true; // Can not move a file to the same parent unless we copy
				}

				if (isEqualOrParent(target.resource, source.resource, !isLinux /* ignorecase */)) {
					return true; // Can not move a parent folder into one of its children
				}

				return false;
			})) {
				return false;
			}
		}

		// All (target = model)
		if (!target) {
			return { accept: true, bubble: TreeDragOverBubble.Down };
		}

		// All (target = file/folder)
		else {
			const effect = fromDesktop || isCopy ? ListDragOverEffect.Copy : ListDragOverEffect.Move;

			if (target.isDirectory) {
				if (target.isReadonly) {
					return false;
				}

				return { accept: true, bubble: TreeDragOverBubble.Down, effect, autoExpand: true };
			}

			if (this.contextService.getWorkspace().folders.every(folder => folder.uri.toString() !== target.resource.toString())) {
				return { accept: true, bubble: TreeDragOverBubble.Up, effect };
			}
		}

		return false;
	}

	getDragURI(element: ExplorerItem): string {
		return element.resource.toString();
	}

	getDragLabel(elements: ExplorerItem[]): string {
		if (elements.length > 1) {
			return String(elements.length);
		}

		return elements[0].name;
	}

	onDragStart(data: IDragAndDropData, originalEvent: DragEvent): void {
		const items = (data as ElementsDragAndDropData<ExplorerItem>).elements;
		if (items && items.length) {
			// Apply some datatransfer types to allow for dragging the element outside of the application
			this.instantiationService.invokeFunction(fillResourceDataTransfers, items, originalEvent);

			// The only custom data transfer we set from the explorer is a file transfer
			// to be able to DND between multiple code file explorers across windows
			const fileResources = items.filter(s => !s.isDirectory && s.resource.scheme === Schemas.file).map(r => r.resource.fsPath);
			if (fileResources.length) {
				originalEvent.dataTransfer.setData(CodeDataTransfers.FILES, JSON.stringify(fileResources));
			}
		}
	}

	drop(data: IDragAndDropData, target: ExplorerItem, targetIndex: number, originalEvent: DragEvent): void {
		// Find parent to add to
		if (!target) {
			target = this.explorerService.roots[this.explorerService.roots.length - 1];
		}
		if (!target.isDirectory) {
			target = target.parent;
		}
		if (target.isReadonly) {
			return;
		}

		// Desktop DND (Import file)
		if (data instanceof DesktopDragAndDropData) {
			this.handleExternalDrop(data, target, originalEvent);
		}
		// In-Explorer DND (Move/Copy file)
		else {
			this.handleExplorerDrop(data, target, originalEvent);
		}
	}


	private handleExternalDrop(data: DesktopDragAndDropData, target: ExplorerItem, originalEvent: DragEvent): Promise<void> {
		const droppedResources = extractResources(originalEvent, true);

		// Check for dropped external files to be folders
		return this.fileService.resolveFiles(droppedResources).then(result => {

			// Pass focus to window
			this.windowService.focusWindow();

			// Handle folders by adding to workspace if we are in workspace context
			const folders = result.filter(r => r.success && r.stat.isDirectory).map(result => ({ uri: result.stat.resource }));
			if (folders.length > 0) {

				// If we are in no-workspace context, ask for confirmation to create a workspace
				let confirmedPromise: Promise<IConfirmationResult> = Promise.resolve({ confirmed: true });
				if (this.contextService.getWorkbenchState() !== WorkbenchState.WORKSPACE) {
					confirmedPromise = this.dialogService.confirm({
						message: folders.length > 1 ? localize('dropFolders', "Do you want to add the folders to the workspace?") : localize('dropFolder', "Do you want to add the folder to the workspace?"),
						type: 'question',
						primaryButton: folders.length > 1 ? localize('addFolders', "&&Add Folders") : localize('addFolder', "&&Add Folder")
					});
				}

				return confirmedPromise.then(res => {
					if (res.confirmed) {
						return this.workspaceEditingService.addFolders(folders);
					}

					return undefined;
				});
			}

			// Handle dropped files (only support FileStat as target)
			else if (target instanceof ExplorerItem) {
				return this.addResources(target, droppedResources.map(res => res.resource));
			}

			return undefined;
		});
	}

	private addResources(target: ExplorerItem, resources: URI[]): Promise<any> {
		if (resources && resources.length > 0) {

			// Resolve target to check for name collisions and ask user
			return this.fileService.resolveFile(target.resource).then((targetStat: IFileStat) => {

				// Check for name collisions
				const targetNames = new Set<string>();
				targetStat.children.forEach((child) => {
					targetNames.add(isLinux ? child.name : child.name.toLowerCase());
				});

				let overwritePromise: Promise<IConfirmationResult> = Promise.resolve({ confirmed: true });
				if (resources.some(resource => {
					return targetNames.has(!hasToIgnoreCase(resource) ? basename(resource) : basename(resource).toLowerCase());
				})) {
					const confirm: IConfirmation = {
						message: localize('confirmOverwrite', "A file or folder with the same name already exists in the destination folder. Do you want to replace it?"),
						detail: localize('irreversible', "This action is irreversible!"),
						primaryButton: localize({ key: 'replaceButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Replace"),
						type: 'warning'
					};

					overwritePromise = this.dialogService.confirm(confirm);
				}

				return overwritePromise.then(res => {
					if (!res.confirmed) {
						return undefined;
					}

					// Run add in sequence
					const addPromisesFactory: ITask<Promise<void>>[] = [];
					resources.forEach(resource => {
						addPromisesFactory.push(() => {
							const sourceFile = resource;
							const targetFile = joinPath(target.resource, basename(sourceFile));

							// if the target exists and is dirty, make sure to revert it. otherwise the dirty contents
							// of the target file would replace the contents of the added file. since we already
							// confirmed the overwrite before, this is OK.
							let revertPromise: Promise<ITextFileOperationResult> = Promise.resolve(null);
							if (this.textFileService.isDirty(targetFile)) {
								revertPromise = this.textFileService.revertAll([targetFile], { soft: true });
							}

							return revertPromise.then(() => {
								const copyTarget = joinPath(target.resource, basename(sourceFile));
								return this.fileService.copyFile(sourceFile, copyTarget, true).then(stat => {

									// if we only add one file, just open it directly
									if (resources.length === 1) {
										this.editorService.openEditor({ resource: stat.resource, options: { pinned: true } });
									}
								});
							});
						});
					});

					return sequence(addPromisesFactory);
				});
			});
		}

		return Promise.resolve(undefined);
	}

	private handleExplorerDrop(data: IDragAndDropData, target: ExplorerItem, originalEvent: DragEvent): Promise<void> {
		const elementsData = (data as ElementsDragAndDropData<ExplorerItem>).elements;
		const items = distinctParents(elementsData, s => s.resource);
		const isCopy = (originalEvent.ctrlKey && !isMacintosh) || (originalEvent.altKey && isMacintosh);

		let confirmPromise: Promise<IConfirmationResult>;

		// Handle confirm setting
		const confirmDragAndDrop = !isCopy && this.configurationService.getValue<boolean>(FileDragAndDrop.CONFIRM_DND_SETTING_KEY);
		if (confirmDragAndDrop) {
			confirmPromise = this.dialogService.confirm({
				message: items.length > 1 && items.every(s => s.isRoot) ? localize('confirmRootsMove', "Are you sure you want to change the order of multiple root folders in your workspace?")
					: items.length > 1 ? getConfirmMessage(localize('confirmMultiMove', "Are you sure you want to move the following {0} files?", items.length), items.map(s => s.resource))
						: items[0].isRoot ? localize('confirmRootMove', "Are you sure you want to change the order of root folder '{0}' in your workspace?", items[0].name)
							: localize('confirmMove', "Are you sure you want to move '{0}'?", items[0].name),
				checkbox: {
					label: localize('doNotAskAgain', "Do not ask me again")
				},
				type: 'question',
				primaryButton: localize({ key: 'moveButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Move")
			});
		} else {
			confirmPromise = Promise.resolve({ confirmed: true } as IConfirmationResult);
		}

		return confirmPromise.then(res => {

			// Check for confirmation checkbox
			let updateConfirmSettingsPromise: Promise<void> = Promise.resolve(undefined);
			if (res.confirmed && res.checkboxChecked === true) {
				updateConfirmSettingsPromise = this.configurationService.updateValue(FileDragAndDrop.CONFIRM_DND_SETTING_KEY, false, ConfigurationTarget.USER);
			}

			return updateConfirmSettingsPromise.then(() => {
				if (res.confirmed) {
					const rootDropPromise = this.doHandleRootDrop(items.filter(s => s.isRoot), target);
					return Promise.all(items.filter(s => !s.isRoot).map(source => this.doHandleExplorerDrop(source, target, isCopy)).concat(rootDropPromise)).then(() => undefined);
				}

				return Promise.resolve(undefined);
			});
		});
	}

	private doHandleRootDrop(roots: ExplorerItem[], target: ExplorerItem): Promise<void> {
		if (roots.length === 0) {
			return Promise.resolve(undefined);
		}

		const folders = this.contextService.getWorkspace().folders;
		let targetIndex: number;
		const workspaceCreationData: IWorkspaceFolderCreationData[] = [];
		const rootsToMove: IWorkspaceFolderCreationData[] = [];

		for (let index = 0; index < folders.length; index++) {
			const data = {
				uri: folders[index].uri
			};
			if (target instanceof ExplorerItem && folders[index].uri.toString() === target.resource.toString()) {
				targetIndex = workspaceCreationData.length;
			}

			if (roots.every(r => r.resource.toString() !== folders[index].uri.toString())) {
				workspaceCreationData.push(data);
			} else {
				rootsToMove.push(data);
			}
		}

		workspaceCreationData.splice(targetIndex, 0, ...rootsToMove);
		return this.workspaceEditingService.updateFolders(0, workspaceCreationData.length, workspaceCreationData);
	}

	private doHandleExplorerDrop(source: ExplorerItem, target: ExplorerItem, isCopy: boolean): Promise<void> {
		// Reuse duplicate action if user copies
		if (isCopy) {

			return this.fileService.copyFile(source.resource, findValidPasteFileTarget(target, { resource: source.resource, isDirectory: source.isDirectory })).then(stat => {
				if (!stat.isDirectory) {
					return this.editorService.openEditor({ resource: stat.resource, options: { pinned: true } }).then(() => undefined);
				}

				return undefined;
			});
		}

		// Otherwise move
		const targetResource = joinPath(target.resource, source.name);

		return this.textFileService.move(source.resource, targetResource).then(undefined, error => {

			// Conflict
			if ((<FileOperationError>error).fileOperationResult === FileOperationResult.FILE_MOVE_CONFLICT) {
				const confirm: IConfirmation = {
					message: localize('confirmOverwriteMessage', "'{0}' already exists in the destination folder. Do you want to replace it?", source.name),
					detail: localize('irreversible', "This action is irreversible!"),
					primaryButton: localize({ key: 'replaceButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Replace"),
					type: 'warning'
				};

				// Move with overwrite if the user confirms
				return this.dialogService.confirm(confirm).then(res => {
					if (res.confirmed) {
						return this.textFileService.move(source.resource, targetResource, true /* overwrite */).then(undefined, error => this.notificationService.error(error));
					}

					return undefined;
				});
			}

			// Any other error
			else {
				this.notificationService.error(error);
			}

			return undefined;
		});
	}
}
