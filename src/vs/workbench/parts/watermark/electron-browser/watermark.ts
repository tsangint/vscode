/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'vs/css!./watermark';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { assign } from 'vs/base/common/objects';
import { isMacintosh, OS } from 'vs/base/common/platform';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import * as nls from 'vs/nls';
import { Registry } from 'vs/platform/registry/common/platform';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from 'vs/platform/configuration/common/configurationRegistry';
import { IWorkspaceContextService, WorkbenchState } from 'vs/platform/workspace/common/workspace';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { OpenRecentAction } from 'vs/workbench/electron-browser/actions';
import { GlobalNewUntitledFileAction } from 'vs/workbench/parts/files/electron-browser/fileActions';
import { OpenFolderAction, OpenFileFolderAction, OpenFileAction } from 'vs/workbench/browser/actions/workspaceActions';
import { ShowAllCommandsAction } from 'vs/workbench/parts/quickopen/browser/commandsHandler';
import { Parts, IPartService, IDimension } from 'vs/workbench/services/part/common/partService';
import { StartAction } from 'vs/workbench/parts/debug/browser/debugActions';
import { FindInFilesActionId } from 'vs/workbench/parts/search/common/constants';
import { QUICKOPEN_ACTION_ID } from 'vs/workbench/browser/parts/quickopen/quickopen';
import { TERMINAL_COMMAND_ID } from 'vs/workbench/parts/terminal/common/terminalCommands';
import * as dom from 'vs/base/browser/dom';
import { KeybindingLabel } from 'vs/base/browser/ui/keybindingLabel/keybindingLabel';

const $ = dom.$;

interface WatermarkEntry {
	text: string;
	id: string;
	mac?: boolean;
}

const showCommands: WatermarkEntry = {
	text: nls.localize('watermark.showCommands', "Show All Commands"),
	id: ShowAllCommandsAction.ID
};
const quickOpen: WatermarkEntry = {
	text: nls.localize('watermark.quickOpen', "Go to File"),
	id: QUICKOPEN_ACTION_ID
};
const openFileNonMacOnly: WatermarkEntry = {
	text: nls.localize('watermark.openFile', "Open File"),
	id: OpenFileAction.ID,
	mac: false
};
const openFolderNonMacOnly: WatermarkEntry = {
	text: nls.localize('watermark.openFolder', "Open Folder"),
	id: OpenFolderAction.ID,
	mac: false
};
const openFileOrFolderMacOnly: WatermarkEntry = {
	text: nls.localize('watermark.openFileFolder', "Open File or Folder"),
	id: OpenFileFolderAction.ID,
	mac: true
};
const openRecent: WatermarkEntry = {
	text: nls.localize('watermark.openRecent', "Open Recent"),
	id: OpenRecentAction.ID
};
const newUntitledFile: WatermarkEntry = {
	text: nls.localize('watermark.newUntitledFile', "New Untitled File"),
	id: GlobalNewUntitledFileAction.ID
};
const newUntitledFileMacOnly: WatermarkEntry = assign({ mac: true }, newUntitledFile);
const toggleTerminal: WatermarkEntry = {
	text: nls.localize({ key: 'watermark.toggleTerminal', comment: ['toggle is a verb here'] }, "Toggle Terminal"),
	id: TERMINAL_COMMAND_ID.TOGGLE
};

const findInFiles: WatermarkEntry = {
	text: nls.localize('watermark.findInFiles', "Find in Files"),
	id: FindInFilesActionId
};
const startDebugging: WatermarkEntry = {
	text: nls.localize('watermark.startDebugging', "Start Debugging"),
	id: StartAction.ID
};

const noFolderEntries = [
	showCommands,
	openFileNonMacOnly,
	openFolderNonMacOnly,
	openFileOrFolderMacOnly,
	openRecent,
	newUntitledFileMacOnly
];

const folderEntries = [
	showCommands,
	quickOpen,
	findInFiles,
	startDebugging,
	toggleTerminal
];

const WORKBENCH_TIPS_ENABLED_KEY = 'workbench.tips.enabled';

export class WatermarkContribution implements IWorkbenchContribution {

	private toDispose: IDisposable[] = [];
	private watermark: HTMLElement;
	private enabled: boolean;
	private workbenchState: WorkbenchState;

	constructor(
		@ILifecycleService lifecycleService: ILifecycleService,
		@IPartService private readonly partService: IPartService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		this.workbenchState = contextService.getWorkbenchState();

		lifecycleService.onShutdown(this.dispose, this);
		this.enabled = this.configurationService.getValue<boolean>(WORKBENCH_TIPS_ENABLED_KEY);
		if (this.enabled) {
			this.create();
		}
		this.toDispose.push(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(WORKBENCH_TIPS_ENABLED_KEY)) {
				const enabled = this.configurationService.getValue<boolean>(WORKBENCH_TIPS_ENABLED_KEY);
				if (enabled !== this.enabled) {
					this.enabled = enabled;
					if (this.enabled) {
						this.create();
					} else {
						this.destroy();
					}
				}
			}
		}));
		this.toDispose.push(this.contextService.onDidChangeWorkbenchState(e => {
			const previousWorkbenchState = this.workbenchState;
			this.workbenchState = this.contextService.getWorkbenchState();

			if (this.enabled && this.workbenchState !== previousWorkbenchState) {
				this.recreate();
			}
		}));
	}

	private create(): void {
		const container = this.partService.getContainer(Parts.EDITOR_PART);
		container.classList.add('has-watermark');

		this.watermark = $('.watermark');
		const box = dom.append(this.watermark, $('.watermark-box'));
		const folder = this.workbenchState !== WorkbenchState.EMPTY;
		const selected = folder ? folderEntries : noFolderEntries
			.filter(entry => !('mac' in entry) || entry.mac === isMacintosh);
		const update = () => {
			dom.clearNode(box);
			selected.map(entry => {
				const dl = dom.append(box, $('dl'));
				const dt = dom.append(dl, $('dt'));
				dt.textContent = entry.text;
				const dd = dom.append(dl, $('dd'));
				const keybinding = new KeybindingLabel(dd, OS, { renderUnboundKeybindings: true });
				keybinding.set(this.keybindingService.lookupKeybinding(entry.id));
				dd.innerHTML = keybinding.element.outerHTML;
			});
		};
		update();
		dom.prepend(container.firstElementChild as HTMLElement, this.watermark);
		this.toDispose.push(this.keybindingService.onDidUpdateKeybindings(update));
		this.toDispose.push(this.partService.onEditorLayout(({ height }: IDimension) => {
			container.classList[height <= 478 ? 'add' : 'remove']('max-height-478px');
		}));
	}

	private destroy(): void {
		if (this.watermark) {
			this.watermark.remove();
			this.partService.getContainer(Parts.EDITOR_PART).classList.remove('has-watermark');
			this.dispose();
		}
	}

	private recreate(): void {
		this.destroy();
		this.create();
	}

	public dispose(): void {
		this.toDispose = dispose(this.toDispose);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(WatermarkContribution, LifecyclePhase.Restored);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerConfiguration({
		'id': 'workbench',
		'order': 7,
		'title': nls.localize('workbenchConfigurationTitle', "Workbench"),
		'properties': {
			'workbench.tips.enabled': {
				'type': 'boolean',
				'default': true,
				'description': nls.localize('tips.enabled', "When enabled, will show the watermark tips when no editor is open.")
			},
		}
	});