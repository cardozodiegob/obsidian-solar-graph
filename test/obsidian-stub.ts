/**
 * Minimal stand-in for the `obsidian` module so graph.ts and layout.ts can run
 * under plain node. Only the pieces those two files touch are implemented.
 */

export class TAbstractFile {
	path = "";
	name = "";
	parent: TFolder | null = null;
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];
	isRoot() {
		return this.path === "/";
	}
}

export class TFile extends TAbstractFile {
	extension = "";
	basename = "";
}

export class App {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
