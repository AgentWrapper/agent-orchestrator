export const en = {
	native: {
		menu: {
			file: "File",
			edit: "Edit",
			view: "View",
			window: "Window",
			help: "Help",
			about: "About {{productName}}",
			services: "Services",
			hide: "Hide {{productName}}",
			hideOthers: "Hide Others",
			showAll: "Show All",
			quit: "Quit {{productName}}",
			close: "Close Window",
			undo: "Undo",
			redo: "Redo",
			cut: "Cut",
			copy: "Copy",
			paste: "Paste",
			pasteAndMatchStyle: "Paste and Match Style",
			delete: "Delete",
			selectAll: "Select All",
			substitutions: "Substitutions",
			showSubstitutions: "Show Substitutions",
			smartQuotes: "Smart Quotes",
			smartDashes: "Smart Dashes",
			textReplacement: "Text Replacement",
			speech: "Speech",
			startSpeaking: "Start Speaking",
			stopSpeaking: "Stop Speaking",
			reload: "Reload",
			forceReload: "Force Reload",
			toggleDevTools: "Toggle Developer Tools",
			resetZoom: "Actual Size",
			zoomIn: "Zoom In",
			zoomOut: "Zoom Out",
			toggleFullscreen: "Toggle Full Screen",
			minimize: "Minimize",
			zoom: "Zoom",
			bringAllToFront: "Bring All to Front",
		},
		about: {
			title: "About {{productName}}",
			version: "Version {{version}}",
			ok: "OK",
		},
		directory: {
			chooseRepository: "Choose a git repository",
		},
		updates: {
			enable: "Enable auto-updates",
			notNow: "Not now",
			optInMessage: "Keep Agent Orchestrator up to date automatically?",
			optInDetail: "You can change this later in Settings.",
			stable: "Stable",
			nightly: "Nightly",
			channelMessage: "Which update channel?",
			channelDetail: "Stable is released and tested. Nightly is the newest daily build.",
			ackNightly: "I understand, use Nightly",
			useStable: "Use Stable instead",
			warningMessage: "Nightly builds can be unstable",
			warningDetail:
				"Nightly is built every day and may be broken or lose data. Only use it if you are comfortable with that.",
		},
	},
	settings: {
		language: {
			title: "Language",
			system: "System default",
			english: "English",
			simplifiedChinese: "简体中文",
			effective: "Currently using {{language}}",
			saveFailed: "Could not save language",
		},
	},
} as const;

export type StringShape<T> = {
	readonly [Key in keyof T]: T[Key] extends string
		? string
		: T[Key] extends Record<string, unknown>
			? StringShape<T[Key]>
			: never;
};
