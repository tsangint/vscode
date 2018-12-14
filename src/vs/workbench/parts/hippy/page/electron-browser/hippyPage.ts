/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import 'vs/css!./hippyPage';
import { URI } from 'vs/base/common/uri';
import * as strings from 'vs/base/common/strings';
import * as path from 'path';
import { ICommandService } from 'vs/platform/commands/common/commands';
import * as arrays from 'vs/base/common/arrays';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { onUnexpectedError } from 'vs/base/common/errors';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { TPromise } from 'vs/base/common/winjs.base';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { localize } from 'vs/nls';
import { Action } from 'vs/base/common/actions';
import { Schemas } from 'vs/base/common/network';
import { IBackupFileService } from 'vs/workbench/services/backup/common/backup';
import { getInstalledExtensions, IExtensionStatus } from 'vs/workbench/parts/extensions/electron-browser/extensionsUtils';
import { used } from 'vs/workbench/parts/hippy/page/electron-browser/vs_code_hippy_page';
import { ILifecycleService, StartupKind } from 'vs/platform/lifecycle/common/lifecycle';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { IWorkspaceIdentifier, ISingleFolderWorkspaceIdentifier } from 'vs/platform/workspaces/common/workspaces';
import { IEditorInputFactory, EditorInput } from 'vs/workbench/common/editor';
import { IFileService } from 'vs/platform/files/common/files';
import { HippyEditorInput } from 'vs/workbench/parts/hippy/page/node/hippyEditorInput';

used();

const configurationKey = 'workbench.startupEditor';
const oldConfigurationKey = 'workbench.hippy.enabled';
const telemetryFrom = 'hippyPage';

export class HippyPageContribution implements IWorkbenchContribution {

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IConfigurationService configurationService: IConfigurationService,
		@IEditorService editorService: IEditorService,
		@IBackupFileService backupFileService: IBackupFileService,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService contextService: IWorkspaceContextService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@ICommandService private commandService: ICommandService,
	) {
		const enabled = isWelcomePageEnabled(configurationService, contextService);
		if (enabled && lifecycleService.startupKind !== StartupKind.ReloadedWindow) {
			backupFileService.hasBackups().then(hasBackups => {
				const activeEditor = editorService.activeEditor;
				if (!activeEditor && !hasBackups) {
					const openWithReadme = configurationService.getValue(configurationKey) === 'readme';
					if (openWithReadme) {
						return Promise.all(contextService.getWorkspace().folders.map(folder => {
							const folderUri = folder.uri;
							return fileService.readFolder(folderUri)
								.then(files => {
									const file = arrays.find(files.sort(), file => strings.startsWith(file.toLowerCase(), 'readme'));
									if (file) {
										return folderUri.with({
											path: path.posix.join(folderUri.path, file)
										});
									}
									return undefined;
								}, onUnexpectedError);
						})).then(results => results.filter(result => !!result))
							.then<any>(readmes => {
								if (!editorService.activeEditor) {
									if (readmes.length) {
										const isMarkDown = (readme: URI) => strings.endsWith(readme.path.toLowerCase(), '.md');
										return Promise.all([
											this.commandService.executeCommand('markdown.showPreview', null, readmes.filter(isMarkDown), { locked: true }),
											editorService.openEditors(readmes.filter(readme => !isMarkDown(readme))
												.map(readme => ({ resource: readme }))),
										]);
									} else {
										return instantiationService.createInstance(HippyPage).openEditor();
									}
								}
								return undefined;
							});
					} else {
						return instantiationService.createInstance(HippyPage).openEditor();
					}
				}
				return undefined;
			}).then(null, onUnexpectedError);
		}
	}
}

function isWelcomePageEnabled(configurationService: IConfigurationService, contextService: IWorkspaceContextService) {
	const startupEditor = configurationService.inspect(configurationKey);
	if (!startupEditor.user && !startupEditor.workspace) {
		const welcomeEnabled = configurationService.inspect(oldConfigurationKey);
		if (welcomeEnabled.value !== undefined && welcomeEnabled.value !== null) {
			return welcomeEnabled.value;
		}
	}
	return startupEditor.value === 'welcomePage' || startupEditor.value === 'readme' || startupEditor.value === 'welcomePageInEmptyWorkbench' && contextService.getWorkbenchState() === WorkbenchState.EMPTY;
}

export class HippyPageAction extends Action {

	public static readonly ID = 'workbench.action.showHippyPage';
	public static readonly LABEL = localize('hippyPage', "Hippy");

	constructor(
		id: string,
		label: string,
		@IInstantiationService private instantiationService: IInstantiationService
	) {
		super(id, label);
	}

	public run(): TPromise<void> {
		return this.instantiationService.createInstance(HippyPage)
			.openEditor()
			.then(() => undefined);
	}
}

const hippyInputTypeId = 'workbench.editors.hippyPageInput';

class HippyPage {

	private disposables: IDisposable[] = [];

	readonly editorInput: HippyEditorInput;

	constructor(
		@IEditorService private editorService: IEditorService,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IWindowService private windowService: IWindowService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		this.disposables.push(lifecycleService.onShutdown(() => this.dispose()));

		const recentlyOpened = this.windowService.getRecentlyOpened();
		const installedExtensions = this.instantiationService.invokeFunction(getInstalledExtensions);
		const resource = URI.parse(require.toUrl('./vs_code_hippy_page'))
			.with({
				scheme: Schemas.walkThrough,
				query: JSON.stringify({ moduleId: 'vs/workbench/parts/hippy/page/electron-browser/vs_code_hippy_page' })
			});
		this.editorInput = this.instantiationService.createInstance(HippyEditorInput, {
			typeId: hippyInputTypeId,
			name: localize('hippy.title', "HippyPage"),
			resource,
			telemetryFrom,
			onReady: (container: HTMLElement) => this.onReady(container, recentlyOpened, installedExtensions)
		});
	}

	public openEditor() {
		return this.editorService.openEditor(this.editorInput, { pinned: false });
	}

	private onReady(container: HTMLElement, recentlyOpened: TPromise<{ files: URI[]; workspaces: (IWorkspaceIdentifier | ISingleFolderWorkspaceIdentifier)[]; }>, installedExtensions: TPromise<IExtensionStatus[]>): void {
		console.log(recentlyOpened, container, installedExtensions);
	}

	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}

export class HippyInputFactory implements IEditorInputFactory {

	static readonly ID = hippyInputTypeId;

	public serialize(editorInput: EditorInput): string {
		return '{}';
	}

	public deserialize(instantiationService: IInstantiationService, serializedEditorInput: string): HippyEditorInput {
		return instantiationService.createInstance(HippyPage)
			.editorInput;
	}
}
