/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { Registry } from 'vs/platform/registry/common/platform';
import { HippyPageContribution, HippyPageAction, HippyInputFactory } from 'vs/workbench/parts/hippy/page/electron-browser/hippyPage';
import { IWorkbenchActionRegistry, Extensions as ActionExtensions } from 'vs/workbench/common/actions';
import { SyncActionDescriptor, MenuRegistry, MenuId } from 'vs/platform/actions/common/actions';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from 'vs/platform/configuration/common/configurationRegistry';
import { IEditorInputFactoryRegistry, Extensions as EditorExtensions } from 'vs/workbench/common/editor';
import { LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerConfiguration({
		'id': 'workbench',
		'order': 100,
		'title': 'Hippy Test'
	});

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(HippyPageContribution, LifecyclePhase.Running);

Registry.as<IWorkbenchActionRegistry>(ActionExtensions.WorkbenchActions)
	.registerWorkbenchAction(new SyncActionDescriptor(HippyPageAction, HippyPageAction.ID, HippyPageAction.LABEL), 'Help: Hippy', localize('help', "Help"));

Registry.as<IEditorInputFactoryRegistry>(EditorExtensions.EditorInputFactories).registerEditorInputFactory(HippyInputFactory.ID, HippyInputFactory);

MenuRegistry.appendMenuItem(MenuId.MenubarHelpMenu, {
	group: '1_welcome',
	command: {
		id: 'workbench.action.showHippyPage',
		title: 'HippyPage@Help'
	},
	order: 1
});
