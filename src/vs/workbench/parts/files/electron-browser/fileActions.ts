/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./media/fileactions';
import * as nls from 'vs/nls';
import * as types from 'vs/base/common/types';
import { isWindows, isLinux } from 'vs/base/common/platform';
import { always } from 'vs/base/common/async';
import * as paths from 'vs/base/common/paths';
import * as resources from 'vs/base/common/resources';
import { URI } from 'vs/base/common/uri';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import * as strings from 'vs/base/common/strings';
import { Action } from 'vs/base/common/actions';
import { dispose, IDisposable } from 'vs/base/common/lifecycle';
import { VIEWLET_ID, IExplorerService } from 'vs/workbench/parts/files/common/files';
import { ITextFileService } from 'vs/workbench/services/textfile/common/textfiles';
import { IFileService, AutoSaveConfiguration } from 'vs/platform/files/common/files';
import { toResource, IUntitledResourceInput } from 'vs/workbench/common/editor';
import { ExplorerViewlet } from 'vs/workbench/parts/files/electron-browser/explorerViewlet';
import { IUntitledEditorService } from 'vs/workbench/services/untitled/common/untitledEditorService';
import { IQuickOpenService } from 'vs/platform/quickOpen/common/quickOpen';
import { IViewletService } from 'vs/workbench/services/viewlet/browser/viewlet';
import { IInstantiationService, ServicesAccessor, IConstructorSignature1 } from 'vs/platform/instantiation/common/instantiation';
import { ITextModel } from 'vs/editor/common/model';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { REVEAL_IN_EXPLORER_COMMAND_ID, SAVE_ALL_COMMAND_ID, SAVE_ALL_LABEL, SAVE_ALL_IN_GROUP_COMMAND_ID } from 'vs/workbench/parts/files/electron-browser/fileCommands';
import { ITextModelService, ITextModelContentProvider } from 'vs/editor/common/services/resolverService';
import { IConfigurationService, ConfigurationTarget } from 'vs/platform/configuration/common/configuration';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { IModeService } from 'vs/editor/common/services/modeService';
import { IModelService } from 'vs/editor/common/services/modelService';
import { ICommandService, CommandsRegistry } from 'vs/platform/commands/common/commands';
import { IListService, ListWidget } from 'vs/platform/list/browser/listService';
import { RawContextKey } from 'vs/platform/contextkey/common/contextkey';
import { Schemas } from 'vs/base/common/network';
import { IDialogService, IConfirmationResult, getConfirmMessage } from 'vs/platform/dialogs/common/dialogs';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { Constants } from 'vs/editor/common/core/uint';
import { CLOSE_EDITORS_AND_GROUP_COMMAND_ID } from 'vs/workbench/browser/parts/editor/editorCommands';
import { IViewlet } from 'vs/workbench/common/viewlet';
import { coalesce } from 'vs/base/common/arrays';
import { AsyncDataTree } from 'vs/base/browser/ui/tree/asyncDataTree';
import { ExplorerItem } from 'vs/workbench/parts/files/common/explorerModel';
import { onUnexpectedError } from 'vs/base/common/errors';

export const NEW_FILE_COMMAND_ID = 'explorer.newFile';
export const NEW_FILE_LABEL = nls.localize('newFile', "New File");

export const NEW_FOLDER_COMMAND_ID = 'explorer.newFolder';
export const NEW_FOLDER_LABEL = nls.localize('newFolder', "New Folder");

export const TRIGGER_RENAME_LABEL = nls.localize('rename', "Rename");

export const MOVE_FILE_TO_TRASH_LABEL = nls.localize('delete', "Delete");

export const COPY_FILE_LABEL = nls.localize('copyFile', "Copy");

export const PASTE_FILE_LABEL = nls.localize('pasteFile', "Paste");

export const FileCopiedContext = new RawContextKey<boolean>('fileCopied', false);

export class BaseErrorReportingAction extends Action {

	constructor(
		id: string,
		label: string,
		private _notificationService: INotificationService
	) {
		super(id, label);
	}

	public get notificationService() {
		return this._notificationService;
	}

	protected onError(error: any): void {
		if (error.message === 'string') {
			error = error.message;
		}

		this._notificationService.error(toErrorMessage(error, false));
	}

	protected onErrorWithRetry(error: any, retry: () => Promise<any>): void {
		this._notificationService.prompt(Severity.Error, toErrorMessage(error, false),
			[{
				label: nls.localize('retry', "Retry"),
				run: () => retry()
			}]
		);
	}
}

const PLACEHOLDER_URI = URI.file('');

/* New File */
export class NewFileAction extends BaseErrorReportingAction {
	static readonly ID = 'workbench.files.action.createFileFromExplorer';
	static readonly LABEL = nls.localize('createNewFile', "New File");

	constructor(
		private getElement: () => ExplorerItem,
		@INotificationService notificationService: INotificationService,
		@IExplorerService private explorerService: IExplorerService,
		@IFileService private fileService: IFileService,
		@IEditorService private editorService: IEditorService
	) {
		super('explorer.newFile', NEW_FILE_LABEL, notificationService);
		this.class = 'explorer-action new-file';
	}

	run(): Promise<any> {
		let folder: ExplorerItem;
		const element = this.getElement();
		if (element) {
			folder = element.isDirectory ? element : element.parent;
		} else {
			folder = this.explorerService.roots[0];
		}

		if (folder.isReadonly) {
			return Promise.reject(new Error('Parent folder is readonly.'));
		}

		const stat = new ExplorerItem(PLACEHOLDER_URI, folder, false);
		return folder.fetchChildren(this.fileService).then(() => {
			folder.addChild(stat);

			const onSuccess = value => {
				return this.fileService.createFile(resources.joinPath(folder.resource, value)).then(stat => {
					return this.editorService.openEditor({ resource: stat.resource, options: { pinned: true } });
				}, (error) => {
					this.onErrorWithRetry(error, () => onSuccess(value));
				});
			};

			this.explorerService.setEditable(stat, {
				validationMessage: value => validateFileName(stat, value),
				onFinish: (value, success) => {
					folder.removeChild(stat);
					this.explorerService.setEditable(stat, null);
					if (success) {
						onSuccess(value);
					}
				}
			});
		});
	}
}

/* New Folder */
export class NewFolderAction extends BaseErrorReportingAction {
	static readonly ID = 'workbench.files.action.createFolderFromExplorer';
	static readonly LABEL = nls.localize('createNewFolder', "New Folder");

	constructor(
		private getElement: () => ExplorerItem,
		@INotificationService notificationService: INotificationService,
		@IFileService private fileService: IFileService,
		@IExplorerService private explorerService: IExplorerService
	) {
		super('explorer.newFolder', NEW_FOLDER_LABEL, notificationService);
		this.class = 'explorer-action new-folder';
	}

	run(): Promise<any> {
		let folder: ExplorerItem;
		const element = this.getElement();
		if (element) {
			folder = element.isDirectory ? element : element.parent;
		} else {
			folder = this.explorerService.roots[0];
		}

		if (folder.isReadonly) {
			return Promise.reject(new Error('Parent folder is readonly.'));
		}

		const stat = new ExplorerItem(PLACEHOLDER_URI, folder, true);
		return folder.fetchChildren(this.fileService).then(() => {
			folder.addChild(stat);

			const onSuccess = value => {
				return this.fileService.createFolder(resources.joinPath(folder.resource, value)).then(stat => {
					return this.explorerService.select(stat.resource, true);
				}, (error) => {
					this.onErrorWithRetry(error, () => onSuccess(value));
				});
			};

			this.explorerService.setEditable(stat, {
				validationMessage: value => validateFileName(stat, value),
				onFinish: (value, success) => {
					folder.removeChild(stat);
					this.explorerService.setEditable(stat, null);
					if (success) {
						onSuccess(value);
					}
				}
			});
		});
	}
}

/* Create new file from anywhere: Open untitled */
export class GlobalNewUntitledFileAction extends Action {
	public static readonly ID = 'workbench.action.files.newUntitledFile';
	public static readonly LABEL = nls.localize('newUntitledFile', "New Untitled File");

	constructor(
		id: string,
		label: string,
		@IEditorService private readonly editorService: IEditorService
	) {
		super(id, label);
	}

	public run(): Promise<any> {
		return this.editorService.openEditor({ options: { pinned: true } } as IUntitledResourceInput); // untitled are always pinned
	}
}

class BaseDeleteFileAction extends BaseErrorReportingAction {

	private static readonly CONFIRM_DELETE_SETTING_KEY = 'explorer.confirmDelete';

	private skipConfirm: boolean;

	constructor(
		private elements: ExplorerItem[],
		private useTrash: boolean,
		@IFileService private readonly fileService: IFileService,
		@INotificationService notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super('moveFileToTrash', MOVE_FILE_TO_TRASH_LABEL, notificationService);

		this.useTrash = useTrash && elements.every(e => !paths.isUNC(e.resource.fsPath)); // on UNC shares there is no trash
		this.enabled = this.elements && this.elements.every(e => !e.isReadonly);
	}

	public run(): Promise<any> {

		let primaryButton: string;
		if (this.useTrash) {
			primaryButton = isWindows ? nls.localize('deleteButtonLabelRecycleBin', "&&Move to Recycle Bin") : nls.localize({ key: 'deleteButtonLabelTrash', comment: ['&& denotes a mnemonic'] }, "&&Move to Trash");
		} else {
			primaryButton = nls.localize({ key: 'deleteButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Delete");
		}

		const distinctElements = resources.distinctParents(this.elements, e => e.resource);

		// Handle dirty
		let confirmDirtyPromise: Promise<boolean> = Promise.resolve(true);
		const dirty = this.textFileService.getDirty().filter(d => distinctElements.some(e => resources.isEqualOrParent(d, e.resource, !isLinux /* ignorecase */)));
		if (dirty.length) {
			let message: string;
			if (distinctElements.length > 1) {
				message = nls.localize('dirtyMessageFilesDelete', "You are deleting files with unsaved changes. Do you want to continue?");
			} else if (distinctElements[0].isDirectory) {
				if (dirty.length === 1) {
					message = nls.localize('dirtyMessageFolderOneDelete', "You are deleting a folder with unsaved changes in 1 file. Do you want to continue?");
				} else {
					message = nls.localize('dirtyMessageFolderDelete', "You are deleting a folder with unsaved changes in {0} files. Do you want to continue?", dirty.length);
				}
			} else {
				message = nls.localize('dirtyMessageFileDelete', "You are deleting a file with unsaved changes. Do you want to continue?");
			}

			confirmDirtyPromise = this.dialogService.confirm({
				message,
				type: 'warning',
				detail: nls.localize('dirtyWarning', "Your changes will be lost if you don't save them."),
				primaryButton
			}).then(res => {
				if (!res.confirmed) {
					return false;
				}

				this.skipConfirm = true; // since we already asked for confirmation
				return this.textFileService.revertAll(dirty).then(() => true);
			});
		}

		// Check if file is dirty in editor and save it to avoid data loss
		return confirmDirtyPromise.then(confirmed => {
			if (!confirmed) {
				return null;
			}

			let confirmDeletePromise: Promise<IConfirmationResult>;

			// Check if we need to ask for confirmation at all
			if (this.skipConfirm || (this.useTrash && this.configurationService.getValue<boolean>(BaseDeleteFileAction.CONFIRM_DELETE_SETTING_KEY) === false)) {
				confirmDeletePromise = Promise.resolve({ confirmed: true } as IConfirmationResult);
			}

			// Confirm for moving to trash
			else if (this.useTrash) {
				const message = this.getMoveToTrashMessage(distinctElements);

				confirmDeletePromise = this.dialogService.confirm({
					message,
					detail: isWindows ? nls.localize('undoBin', "You can restore from the Recycle Bin.") : nls.localize('undoTrash', "You can restore from the Trash."),
					primaryButton,
					checkbox: {
						label: nls.localize('doNotAskAgain', "Do not ask me again")
					},
					type: 'question'
				});
			}

			// Confirm for deleting permanently
			else {
				const message = this.getDeleteMessage(distinctElements);
				confirmDeletePromise = this.dialogService.confirm({
					message,
					detail: nls.localize('irreversible', "This action is irreversible!"),
					primaryButton,
					type: 'warning'
				});
			}

			return confirmDeletePromise.then(confirmation => {

				// Check for confirmation checkbox
				let updateConfirmSettingsPromise: Promise<void> = Promise.resolve(undefined);
				if (confirmation.confirmed && confirmation.checkboxChecked === true) {
					updateConfirmSettingsPromise = this.configurationService.updateValue(BaseDeleteFileAction.CONFIRM_DELETE_SETTING_KEY, false, ConfigurationTarget.USER);
				}

				return updateConfirmSettingsPromise.then(() => {

					// Check for confirmation
					if (!confirmation.confirmed) {
						return Promise.resolve(null);
					}

					// Call function
					const servicePromise = Promise.all(distinctElements.map(e => this.fileService.del(e.resource, { useTrash: this.useTrash, recursive: true })))
						.then(undefined, (error: any) => {
							// Handle error to delete file(s) from a modal confirmation dialog
							let errorMessage: string;
							let detailMessage: string;
							let primaryButton: string;
							if (this.useTrash) {
								errorMessage = isWindows ? nls.localize('binFailed', "Failed to delete using the Recycle Bin. Do you want to permanently delete instead?") : nls.localize('trashFailed', "Failed to delete using the Trash. Do you want to permanently delete instead?");
								detailMessage = nls.localize('irreversible', "This action is irreversible!");
								primaryButton = nls.localize({ key: 'deletePermanentlyButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Delete Permanently");
							} else {
								errorMessage = toErrorMessage(error, false);
								primaryButton = nls.localize({ key: 'retryButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Retry");
							}

							return this.dialogService.confirm({
								message: errorMessage,
								detail: detailMessage,
								type: 'warning',
								primaryButton
							}).then(res => {

								if (res.confirmed) {
									if (this.useTrash) {
										this.useTrash = false; // Delete Permanently
									}

									this.skipConfirm = true;

									return this.run();
								}

								return Promise.resolve(undefined);
							});
						});

					return servicePromise;
				});
			});
		});
	}

	private getMoveToTrashMessage(distinctElements: ExplorerItem[]): string {
		if (this.containsBothDirectoryAndFile(distinctElements)) {
			return getConfirmMessage(nls.localize('confirmMoveTrashMessageFilesAndDirectories', "Are you sure you want to delete the following {0} files/directories and their contents?", distinctElements.length), distinctElements.map(e => e.resource));
		}

		if (distinctElements.length > 1) {
			if (distinctElements[0].isDirectory) {
				return getConfirmMessage(nls.localize('confirmMoveTrashMessageMultipleDirectories', "Are you sure you want to delete the following {0} directories and their contents?", distinctElements.length), distinctElements.map(e => e.resource));
			}

			return getConfirmMessage(nls.localize('confirmMoveTrashMessageMultiple', "Are you sure you want to delete the following {0} files?", distinctElements.length), distinctElements.map(e => e.resource));
		}

		if (distinctElements[0].isDirectory) {
			return nls.localize('confirmMoveTrashMessageFolder', "Are you sure you want to delete '{0}' and its contents?", distinctElements[0].name);
		}

		return nls.localize('confirmMoveTrashMessageFile', "Are you sure you want to delete '{0}'?", distinctElements[0].name);
	}

	private getDeleteMessage(distinctElements: ExplorerItem[]): string {
		if (this.containsBothDirectoryAndFile(distinctElements)) {
			return getConfirmMessage(nls.localize('confirmDeleteMessageFilesAndDirectories', "Are you sure you want to permanently delete the following {0} files/directories and their contents?", distinctElements.length), distinctElements.map(e => e.resource));
		}

		if (distinctElements.length > 1) {
			if (distinctElements[0].isDirectory) {
				return getConfirmMessage(nls.localize('confirmDeleteMessageMultipleDirectories', "Are you sure you want to permanently delete the following {0} directories and their contents?", distinctElements.length), distinctElements.map(e => e.resource));
			}

			return getConfirmMessage(nls.localize('confirmDeleteMessageMultiple', "Are you sure you want to permanently delete the following {0} files?", distinctElements.length), distinctElements.map(e => e.resource));
		}

		if (distinctElements[0].isDirectory) {
			return nls.localize('confirmDeleteMessageFolder', "Are you sure you want to permanently delete '{0}' and its contents?", distinctElements[0].name);
		}

		return nls.localize('confirmDeleteMessageFile', "Are you sure you want to permanently delete '{0}'?", distinctElements[0].name);
	}

	private containsBothDirectoryAndFile(distinctElements: ExplorerItem[]): boolean {
		const directories = distinctElements.filter(element => element.isDirectory);
		const files = distinctElements.filter(element => !element.isDirectory);

		return directories.length > 0 && files.length > 0;
	}
}

let pasteShouldMove = false;
// Copy File/Folder
class CopyFileAction extends BaseErrorReportingAction {

	constructor(
		private elements: ExplorerItem[],
		@INotificationService notificationService: INotificationService,
		@IClipboardService private readonly clipboardService: IClipboardService
	) {
		super('filesExplorer.copy', COPY_FILE_LABEL, notificationService);
	}

	public run(): Promise<any> {

		// Write to clipboard as file/folder to copy
		this.clipboardService.writeResources(this.elements.map(e => e.resource));
		pasteShouldMove = false;

		return Promise.resolve(null);
	}
}

// Paste File/Folder
class PasteFileAction extends BaseErrorReportingAction {

	public static readonly ID = 'filesExplorer.paste';

	constructor(
		private element: ExplorerItem,
		@IFileService private fileService: IFileService,
		@INotificationService notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
		@IExplorerService private readonly explorerService: IExplorerService
	) {
		super(PasteFileAction.ID, PASTE_FILE_LABEL, notificationService);

		if (!this.element) {
			this.element = this.explorerService.roots[0];
		}
	}

	public run(fileToPaste: URI): Promise<any> {

		// Check if target is ancestor of pasted folder
		if (this.element.resource.toString() !== fileToPaste.toString() && resources.isEqualOrParent(this.element.resource, fileToPaste, !isLinux /* ignorecase */)) {
			throw new Error(nls.localize('fileIsAncestor', "File to paste is an ancestor of the destination folder"));
		}

		return this.fileService.resolveFile(fileToPaste).then(fileToPasteStat => {

			// Find target
			let target: ExplorerItem;
			if (this.element.resource.toString() === fileToPaste.toString()) {
				target = this.element.parent;
			} else {
				target = this.element.isDirectory ? this.element : this.element.parent;
			}

			const targetFile = findValidPasteFileTarget(target, { resource: fileToPaste, isDirectory: fileToPasteStat.isDirectory });

			// Copy File
			const promise = pasteShouldMove ? this.fileService.moveFile(fileToPaste, targetFile) : this.fileService.copyFile(fileToPaste, targetFile);
			return promise.then(stat => {
				if (!stat.isDirectory) {
					return this.editorService.openEditor({ resource: stat.resource, options: { pinned: true, preserveFocus: true } });
				}

				return undefined;
			});
		}, error => {
			this.onError(new Error(nls.localize('fileDeleted', "File to paste was deleted or moved meanwhile")));
		});
	}
}

export function findValidPasteFileTarget(targetFolder: ExplorerItem, fileToPaste: { resource: URI, isDirectory?: boolean }): URI {
	let name = resources.basenameOrAuthority(fileToPaste.resource);

	let candidate = resources.joinPath(targetFolder.resource, name);
	while (true) {
		if (!targetFolder.root.find(candidate)) {
			break;
		}

		name = incrementFileName(name, fileToPaste.isDirectory);
		candidate = resources.joinPath(targetFolder.resource, name);
	}

	return candidate;
}

export function incrementFileName(name: string, isFolder: boolean): string {
	const separators = '[\\.\\-_]';
	const maxNumber = Constants.MAX_SAFE_SMALL_INTEGER;

	// file.1.txt=>file.2.txt
	let suffixFileRegex = RegExp('(.*' + separators + ')(\\d+)(\\..*)$');
	if (!isFolder && name.match(suffixFileRegex)) {
		return name.replace(suffixFileRegex, (match, g1?, g2?, g3?) => {
			let number = parseInt(g2);
			return number < maxNumber
				? g1 + strings.pad(number + 1, g2.length) + g3
				: strings.format('{0}{1}.1{2}', g1, g2, g3);
		});
	}

	// 1.file.txt=>2.file.txt
	let prefixFileRegex = RegExp('(\\d+)(' + separators + '.*)(\\..*)$');
	if (!isFolder && name.match(prefixFileRegex)) {
		return name.replace(prefixFileRegex, (match, g1?, g2?, g3?) => {
			let number = parseInt(g1);
			return number < maxNumber
				? strings.pad(number + 1, g1.length) + g2 + g3
				: strings.format('{0}{1}.1{2}', g1, g2, g3);
		});
	}

	// 1.txt=>2.txt
	let prefixFileNoNameRegex = RegExp('(\\d+)(\\..*)$');
	if (!isFolder && name.match(prefixFileNoNameRegex)) {
		return name.replace(prefixFileNoNameRegex, (match, g1?, g2?) => {
			let number = parseInt(g1);
			return number < maxNumber
				? strings.pad(number + 1, g1.length) + g2
				: strings.format('{0}.1{1}', g1, g2);
		});
	}

	// file.txt=>file.1.txt
	const lastIndexOfDot = name.lastIndexOf('.');
	if (!isFolder && lastIndexOfDot >= 0) {
		return strings.format('{0}.1{1}', name.substr(0, lastIndexOfDot), name.substr(lastIndexOfDot));
	}

	// folder.1=>folder.2
	if (isFolder && name.match(/(\d+)$/)) {
		return name.replace(/(\d+)$/, (match: string, ...groups: any[]) => {
			let number = parseInt(groups[0]);
			return number < maxNumber
				? strings.pad(number + 1, groups[0].length)
				: strings.format('{0}.1', groups[0]);
		});
	}

	// 1.folder=>2.folder
	if (isFolder && name.match(/^(\d+)/)) {
		return name.replace(/^(\d+)(.*)$/, (match: string, ...groups: any[]) => {
			let number = parseInt(groups[0]);
			return number < maxNumber
				? strings.pad(number + 1, groups[0].length) + groups[1]
				: strings.format('{0}{1}.1', groups[0], groups[1]);
		});
	}

	// file/folder=>file.1/folder.1
	return strings.format('{0}.1', name);
}

// Global Compare with
export class GlobalCompareResourcesAction extends Action {

	public static readonly ID = 'workbench.files.action.compareFileWith';
	public static readonly LABEL = nls.localize('globalCompareFile', "Compare Active File With...");

	constructor(
		id: string,
		label: string,
		@IQuickOpenService private readonly quickOpenService: IQuickOpenService,
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super(id, label);
	}

	public run(): Promise<any> {
		const activeInput = this.editorService.activeEditor;
		const activeResource = activeInput ? activeInput.getResource() : undefined;
		if (activeResource) {

			// Compare with next editor that opens
			const toDispose = this.editorService.overrideOpenEditor(editor => {

				// Only once!
				toDispose.dispose();

				// Open editor as diff
				const resource = editor.getResource();
				if (resource) {
					return {
						override: this.editorService.openEditor({
							leftResource: activeResource,
							rightResource: resource
						}).then(() => undefined)
					};
				}

				return undefined;
			});

			// Bring up quick open
			this.quickOpenService.show('', { autoFocus: { autoFocusSecondEntry: true } }).then(() => {
				toDispose.dispose(); // make sure to unbind if quick open is closing
			});
		} else {
			this.notificationService.info(nls.localize('openFileToCompare', "Open a file first to compare it with another file."));
		}

		return Promise.resolve(true);
	}
}

export class ToggleAutoSaveAction extends Action {
	public static readonly ID = 'workbench.action.toggleAutoSave';
	public static readonly LABEL = nls.localize('toggleAutoSave', "Toggle Auto Save");

	constructor(
		id: string,
		label: string,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super(id, label);
	}

	public run(): Promise<any> {
		const setting = this.configurationService.inspect('files.autoSave');
		let userAutoSaveConfig = setting.user;
		if (types.isUndefinedOrNull(userAutoSaveConfig)) {
			userAutoSaveConfig = setting.default; // use default if setting not defined
		}

		let newAutoSaveValue: string;
		if ([AutoSaveConfiguration.AFTER_DELAY, AutoSaveConfiguration.ON_FOCUS_CHANGE, AutoSaveConfiguration.ON_WINDOW_CHANGE].some(s => s === userAutoSaveConfig)) {
			newAutoSaveValue = AutoSaveConfiguration.OFF;
		} else {
			newAutoSaveValue = AutoSaveConfiguration.AFTER_DELAY;
		}

		return this.configurationService.updateValue('files.autoSave', newAutoSaveValue, ConfigurationTarget.USER);
	}
}

export abstract class BaseSaveAllAction extends BaseErrorReportingAction {
	private toDispose: IDisposable[];
	private lastIsDirty: boolean;

	constructor(
		id: string,
		label: string,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IUntitledEditorService private readonly untitledEditorService: IUntitledEditorService,
		@ICommandService protected commandService: ICommandService,
		@INotificationService notificationService: INotificationService,
	) {
		super(id, label, notificationService);

		this.toDispose = [];
		this.lastIsDirty = this.textFileService.isDirty();
		this.enabled = this.lastIsDirty;

		this.registerListeners();
	}

	protected abstract includeUntitled(): boolean;
	protected abstract doRun(context: any): Promise<any>;

	private registerListeners(): void {

		// listen to files being changed locally
		this.toDispose.push(this.textFileService.models.onModelsDirty(e => this.updateEnablement(true)));
		this.toDispose.push(this.textFileService.models.onModelsSaved(e => this.updateEnablement(false)));
		this.toDispose.push(this.textFileService.models.onModelsReverted(e => this.updateEnablement(false)));
		this.toDispose.push(this.textFileService.models.onModelsSaveError(e => this.updateEnablement(true)));

		if (this.includeUntitled()) {
			this.toDispose.push(this.untitledEditorService.onDidChangeDirty(resource => this.updateEnablement(this.untitledEditorService.isDirty(resource))));
		}
	}

	private updateEnablement(isDirty: boolean): void {
		if (this.lastIsDirty !== isDirty) {
			this.enabled = this.textFileService.isDirty();
			this.lastIsDirty = this.enabled;
		}
	}

	public run(context?: any): Promise<boolean> {
		return this.doRun(context).then(() => true, error => {
			this.onError(error);
			return null;
		});
	}

	public dispose(): void {
		this.toDispose = dispose(this.toDispose);

		super.dispose();
	}
}

export class SaveAllAction extends BaseSaveAllAction {

	public static readonly ID = 'workbench.action.files.saveAll';
	public static readonly LABEL = SAVE_ALL_LABEL;

	public get class(): string {
		return 'explorer-action save-all';
	}

	protected doRun(context: any): Promise<any> {
		return this.commandService.executeCommand(SAVE_ALL_COMMAND_ID);
	}

	protected includeUntitled(): boolean {
		return true;
	}
}

export class SaveAllInGroupAction extends BaseSaveAllAction {

	public static readonly ID = 'workbench.files.action.saveAllInGroup';
	public static readonly LABEL = nls.localize('saveAllInGroup', "Save All in Group");

	public get class(): string {
		return 'explorer-action save-all';
	}

	protected doRun(context: any): Promise<any> {
		return this.commandService.executeCommand(SAVE_ALL_IN_GROUP_COMMAND_ID, {}, context);
	}

	protected includeUntitled(): boolean {
		return true;
	}
}

export class CloseGroupAction extends Action {

	public static readonly ID = 'workbench.files.action.closeGroup';
	public static readonly LABEL = nls.localize('closeGroup', "Close Group");

	constructor(id: string, label: string, @ICommandService private readonly commandService: ICommandService) {
		super(id, label, 'action-close-all-files');
	}

	public run(context?: any): Promise<any> {
		return this.commandService.executeCommand(CLOSE_EDITORS_AND_GROUP_COMMAND_ID, {}, context);
	}
}

export class FocusFilesExplorer extends Action {

	public static readonly ID = 'workbench.files.action.focusFilesExplorer';
	public static readonly LABEL = nls.localize('focusFilesExplorer', "Focus on Files Explorer");

	constructor(
		id: string,
		label: string,
		@IViewletService private readonly viewletService: IViewletService
	) {
		super(id, label);
	}

	public run(): Promise<any> {
		return this.viewletService.openViewlet(VIEWLET_ID, true);
	}
}

export class ShowActiveFileInExplorer extends Action {

	public static readonly ID = 'workbench.files.action.showActiveFileInExplorer';
	public static readonly LABEL = nls.localize('showInExplorer', "Reveal Active File in Side Bar");

	constructor(
		id: string,
		label: string,
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService
	) {
		super(id, label);
	}

	public run(): Promise<any> {
		const resource = toResource(this.editorService.activeEditor, { supportSideBySide: true });
		if (resource) {
			this.commandService.executeCommand(REVEAL_IN_EXPLORER_COMMAND_ID, resource);
		} else {
			this.notificationService.info(nls.localize('openFileToShow', "Open a file first to show it in the explorer"));
		}

		return Promise.resolve(true);
	}
}

export class CollapseExplorerView extends Action {

	public static readonly ID = 'workbench.files.action.collapseExplorerFolders';
	public static readonly LABEL = nls.localize('collapseExplorerFolders', "Collapse Folders in Explorer");

	constructor(
		id: string,
		label: string,
		@IViewletService private readonly viewletService: IViewletService
	) {
		super(id, label);
	}

	public run(): Promise<any> {
		return this.viewletService.openViewlet(VIEWLET_ID, true).then((viewlet: ExplorerViewlet) => {
			const explorerView = viewlet.getExplorerView();
			if (explorerView) {
				explorerView.collapseAll();
			}
		});
	}
}

export class RefreshExplorerView extends Action {

	public static readonly ID = 'workbench.files.action.refreshFilesExplorer';
	public static readonly LABEL = nls.localize('refreshExplorer', "Refresh Explorer");

	constructor(
		id: string,
		label: string,
		@IViewletService private readonly viewletService: IViewletService,
		@IExplorerService private readonly explorerService: IExplorerService
	) {
		super(id, label, 'explorer-action refresh-explorer');
	}

	public run(): Promise<any> {
		return this.viewletService.openViewlet(VIEWLET_ID, true).then(() =>
			this.explorerService.refresh()
		);
	}
}

export class ShowOpenedFileInNewWindow extends Action {

	public static readonly ID = 'workbench.action.files.showOpenedFileInNewWindow';
	public static readonly LABEL = nls.localize('openFileInNewWindow', "Open Active File in New Window");

	constructor(
		id: string,
		label: string,
		@IEditorService private readonly editorService: IEditorService,
		@IWindowService private readonly windowService: IWindowService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super(id, label);
	}

	public run(): Promise<any> {
		const fileResource = toResource(this.editorService.activeEditor, { supportSideBySide: true, filter: Schemas.file /* todo@remote */ });
		if (fileResource) {
			this.windowService.openWindow([fileResource], { forceNewWindow: true, forceOpenWorkspaceAsFile: true });
		} else {
			this.notificationService.info(nls.localize('openFileToShowInNewWindow', "Open a file first to open in new window"));
		}

		return Promise.resolve(true);
	}
}

export function validateFileName(item: ExplorerItem, name: string): string {
	// Produce a well formed file name
	name = getWellFormedFileName(name);

	// Name not provided
	if (!name || name.length === 0 || /^\s+$/.test(name)) {
		return nls.localize('emptyFileNameError', "A file or folder name must be provided.");
	}

	// Relative paths only
	if (name[0] === '/' || name[0] === '\\') {
		return nls.localize('fileNameStartsWithSlashError', "A file or folder name cannot start with a slash.");
	}

	const names = coalesce(name.split(/[\\/]/));
	const parent = item.parent;

	if (name !== item.name) {
		// Do not allow to overwrite existing file
		const childExists = parent && !!parent.getChild(name);
		if (childExists) {
			return nls.localize('fileNameExistsError', "A file or folder **{0}** already exists at this location. Please choose a different name.", name);
		}
	}

	// Invalid File name
	if (names.some((folderName) => !paths.isValidBasename(folderName))) {
		return nls.localize('invalidFileNameError', "The name **{0}** is not valid as a file or folder name. Please choose a different name.", trimLongName(name));
	}

	// Max length restriction (on Windows)
	if (isWindows) {
		const fullPathLength = item.resource.fsPath.length + 1 /* path segment */;
		if (fullPathLength > 255) {
			return nls.localize('filePathTooLongError', "The name **{0}** results in a path that is too long. Please choose a shorter name.", trimLongName(name));
		}
	}

	return null;
}

function trimLongName(name: string): string {
	if (name && name.length > 255) {
		return `${name.substr(0, 255)}...`;
	}

	return name;
}

export function getWellFormedFileName(filename: string): string {
	if (!filename) {
		return filename;
	}

	// Trim tabs
	filename = strings.trim(filename, '\t');

	// Remove trailing dots, slashes, and spaces
	filename = strings.rtrim(filename, '.');
	filename = strings.rtrim(filename, '/');
	filename = strings.rtrim(filename, '\\');

	return filename;
}

export class CompareWithClipboardAction extends Action {

	public static readonly ID = 'workbench.files.action.compareWithClipboard';
	public static readonly LABEL = nls.localize('compareWithClipboard', "Compare Active File with Clipboard");

	private static readonly SCHEME = 'clipboardCompare';

	private registrationDisposal: IDisposable;

	constructor(
		id: string,
		label: string,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IFileService private readonly fileService: IFileService
	) {
		super(id, label);

		this.enabled = true;
	}

	public run(): Promise<any> {
		const resource: URI = toResource(this.editorService.activeEditor, { supportSideBySide: true });
		if (resource && (this.fileService.canHandleResource(resource) || resource.scheme === Schemas.untitled)) {
			if (!this.registrationDisposal) {
				const provider = this.instantiationService.createInstance(ClipboardContentProvider);
				this.registrationDisposal = this.textModelService.registerTextModelContentProvider(CompareWithClipboardAction.SCHEME, provider);
			}

			const name = resources.basename(resource);
			const editorLabel = nls.localize('clipboardComparisonLabel', "Clipboard ↔ {0}", name);

			const cleanUp = () => {
				this.registrationDisposal = dispose(this.registrationDisposal);
			};

			return always(this.editorService.openEditor({ leftResource: resource.with({ scheme: CompareWithClipboardAction.SCHEME }), rightResource: resource, label: editorLabel }), cleanUp);
		}

		return Promise.resolve(true);
	}

	public dispose(): void {
		super.dispose();

		this.registrationDisposal = dispose(this.registrationDisposal);
	}
}

class ClipboardContentProvider implements ITextModelContentProvider {
	constructor(
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IModeService private readonly modeService: IModeService,
		@IModelService private readonly modelService: IModelService
	) { }

	provideTextContent(resource: URI): Promise<ITextModel> {
		const model = this.modelService.createModel(this.clipboardService.readText(), this.modeService.create('text/plain'), resource);

		return Promise.resolve(model);
	}
}

interface IExplorerContext {
	stat: ExplorerItem;
	selection: ExplorerItem[];
}

function getContext(listWidget: ListWidget): IExplorerContext {
	// These commands can only be triggered when explorer viewlet is visible so get it using the active viewlet
	const tree = <AsyncDataTree<null, ExplorerItem>>listWidget;
	const focus = tree.getFocus();
	const stat = focus.length ? focus[0] : undefined;
	const selection = tree.getSelection();

	// Only respect the selection if user clicked inside it (focus belongs to it)
	return { stat, selection: selection && selection.indexOf(stat) >= 0 ? selection : [] };
}

// TODO@isidor these commands are calling into actions due to the complex inheritance action structure.
// It should be the other way around, that actions call into commands.
function openExplorerAndRunAction(accessor: ServicesAccessor, constructor: IConstructorSignature1<() => ExplorerItem, Action>): Promise<any> {
	const instantationService = accessor.get(IInstantiationService);
	const listService = accessor.get(IListService);
	const viewletService = accessor.get(IViewletService);
	const activeViewlet = viewletService.getActiveViewlet();
	let explorerPromise: Promise<IViewlet> = Promise.resolve(activeViewlet);
	if (!activeViewlet || activeViewlet.getId() !== VIEWLET_ID) {
		explorerPromise = viewletService.openViewlet(VIEWLET_ID, true);
	}

	return explorerPromise.then((explorer: ExplorerViewlet) => {
		const explorerView = explorer.getExplorerView();
		if (explorerView && explorerView.isBodyVisible()) {
			explorerView.focus();
			const { stat } = getContext(listService.lastFocusedList);
			const action = instantationService.createInstance(constructor, () => stat);

			return action.run();
		}

		return undefined;
	});
}

CommandsRegistry.registerCommand({
	id: NEW_FILE_COMMAND_ID,
	handler: (accessor) => {
		return openExplorerAndRunAction(accessor, NewFileAction);
	}
});

CommandsRegistry.registerCommand({
	id: NEW_FOLDER_COMMAND_ID,
	handler: (accessor) => {
		return openExplorerAndRunAction(accessor, NewFolderAction);
	}
});

export const renameHandler = (accessor: ServicesAccessor) => {
	const listService = accessor.get(IListService);
	const explorerService = accessor.get(IExplorerService);
	const textFileService = accessor.get(ITextFileService);
	const { stat } = getContext(listService.lastFocusedList);

	explorerService.setEditable(stat, {
		validationMessage: value => validateFileName(stat, value),
		onFinish: (value, success) => {
			if (success) {
				const parentResource = stat.parent.resource;
				const targetResource = resources.joinPath(parentResource, value);
				textFileService.move(stat.resource, targetResource).then(undefined, onUnexpectedError);
			}
			explorerService.setEditable(stat, null);
		}
	});
};

export const moveFileToTrashHandler = (accessor: ServicesAccessor) => {
	const instantationService = accessor.get(IInstantiationService);
	const listService = accessor.get(IListService);
	const explorerContext = getContext(listService.lastFocusedList);
	const stats = explorerContext.selection.length > 1 ? explorerContext.selection : [explorerContext.stat];

	const moveFileToTrashAction = instantationService.createInstance(BaseDeleteFileAction, stats, true);
	return moveFileToTrashAction.run();
};

export const deleteFileHandler = (accessor: ServicesAccessor) => {
	const instantationService = accessor.get(IInstantiationService);
	const listService = accessor.get(IListService);
	const explorerContext = getContext(listService.lastFocusedList);
	const stats = explorerContext.selection.length > 1 ? explorerContext.selection : [explorerContext.stat];

	const deleteFileAction = instantationService.createInstance(BaseDeleteFileAction, stats, false);
	return deleteFileAction.run();
};

export const copyFileHandler = (accessor: ServicesAccessor) => {
	const instantationService = accessor.get(IInstantiationService);
	const listService = accessor.get(IListService);
	const explorerContext = getContext(listService.lastFocusedList);
	const stats = explorerContext.selection.length > 1 ? explorerContext.selection : [explorerContext.stat];

	const copyFileAction = instantationService.createInstance(CopyFileAction, stats);
	return copyFileAction.run();
};

export const cutFileHandler = (accessor: ServicesAccessor) => {
	const listService = accessor.get(IListService);
	const explorerContext = getContext(listService.lastFocusedList);
	const clipboardService = accessor.get(IClipboardService);
	const stats = explorerContext.selection.length > 1 ? explorerContext.selection : [explorerContext.stat];
	clipboardService.writeResources(stats.map(s => s.resource));
	pasteShouldMove = true;
};

export const pasteFileHandler = (accessor: ServicesAccessor) => {
	const instantationService = accessor.get(IInstantiationService);
	const listService = accessor.get(IListService);
	const clipboardService = accessor.get(IClipboardService);
	const explorerContext = getContext(listService.lastFocusedList);

	return Promise.all(resources.distinctParents(clipboardService.readResources(), r => r).map(toCopy => {
		const pasteFileAction = instantationService.createInstance(PasteFileAction, explorerContext.stat);
		return pasteFileAction.run(toCopy);
	}));
};
