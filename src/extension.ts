import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import * as path from 'path';
import { glob } from 'glob';

// The name of the extension as defined in package.json
const EXTENSION_NAME = 'vsdelphi';
const MAP2PDB_PATH = path.join(__dirname, '..', 'tools', 'map2pdb', 'map2pdb.exe');

// This method is called when anythin from the `contributes` section
// of the `package.json` is activated or when an event from the
// `activationEvents` section is triggered
export function activate(context: vscode.ExtensionContext) {
	registerCmd(context, 'build', buildDelphi);
	registerCmd(context, 'run', runDelphi);
	registerCmd(context, 'clean', cleanDelphi);
	registerCmd(context, 'debug', debugDelphi);

	checkExtension('embarcaderotechnologies.delphilsp',
		'DelphiLSP provides language support and is recommended.',
		'Install DelphiLSP');
	checkExtension('tuncb.pascal-uses-formatter',
		'PascalUsesFormatter helps keep the `uses` section in alphabetical order.',
		'Install PascalUsesFormatter');
}

function registerCmd(context: vscode.ExtensionContext, cmdName: string, cmdCallback: (...args: any[]) => any) {
	context.subscriptions.push(vscode.commands.registerCommand(`${EXTENSION_NAME}.${cmdName}`, cmdCallback));
}

function createOutputChannel(name: string) {
	const outputChannel = vscode.window.createOutputChannel(name);
	outputChannel.show();

	return outputChannel;
}

function changeExt(p: string, ext: string) {
	return path.format({ ...path.parse(p), base: '', ext });
}

type UnitMappings = {[key: string]: string}

async function debugDelphi() {
	if (!fs.existsSync(MAP2PDB_PATH)) {
		vscode.window.showErrorMessage(`Unable to find map2pdb.exe at ${MAP2PDB_PATH}.`);
		return;
	}

	const outputChannel = createOutputChannel('Debug Delphi');
	await runMSBuildProcess([], outputChannel);

	const dprojFilePath = await getDprojFilePath();
	if (!dprojFilePath) {
		return;
	}
	const exePath = await getExecutableFilePath(dprojFilePath);
	if (!exePath) {
		return;
	}

	const dprFilePath = changeExt(dprojFilePath, '.dpr');

	const dprFiles = await parseDprFiles(dprFilePath);

	const unitSearchPaths = [
		// Delphi default directories
		'$(BDS)\\source\\rtl\\common',
		'C:\\Program Files (x86)\\madCollection\\madExcept\\Sources',

		...await parseUnitSearchPaths(dprojFilePath),
	]

	const files = [
		dprFilePath,
		...dprFiles,
		...await scanFiles(unitSearchPaths),
	];

	let mappings = createMappings(files);

	// make keys of mappings lowercase
	mappings = Object.entries(mappings).reduce((mappings, [key, value]) => ({ ...mappings, [key.toLowerCase()]: value }), {});

	const mapFilePath = changeExt(exePath, '.map');
	if (!await mapPatcher(mapFilePath, mappings, outputChannel)) {
		return;
	}

	const convertProcess = childProcess.spawnSync(MAP2PDB_PATH, ['-bind', mapFilePath]);
	if (convertProcess.error) {
		vscode.window.showErrorMessage(convertProcess.error.message);
	}

	await runDebugger(exePath);
}

async function parseDprFiles(dprFilePath: string) {
	const dprFileDir = path.dirname(dprFilePath);
	return (await fs.promises.readFile(dprFilePath, 'utf8'))
		?.match(/(?<=in \')[^\']+(?=\')/gm)
		?.map(unit => path.join(dprFileDir, unit)) ?? [];
}

function createMappings(filenames: string[]) {
	return filenames.reduce((mappings, filename) => (
		{
			...mappings,
			[path.basename(filename)]: filename,
		}), {});
}

async function parseUnitSearchPaths(dprojFilePath: string) {
	const dprojFileDir = path.dirname(dprojFilePath);
	const resolveSearchPath = (searchPath: string) =>
		path.join(dprojFileDir, searchPath)
			.replace(/.*\$\(BDS\)/, getConfigString('embarcaderoInstallDir'))
			.replaceAll('\\', '/');

	const dprojContent = await fs.promises.readFile(dprojFilePath, 'utf8');

	return dprojContent
		?.match(/(?<=<DCC_UnitSearchPath>).*(?=<\/DCC_UnitSearchPath>)/)
		?.flatMap(paths => paths.split(';'))
		 .filter(searchPath => searchPath !== '$(DCC_UnitSearchPath)')
		 .map(resolveSearchPath) ?? [];
}

async function scanFiles(searchPaths: string[]) {
	// Make the searchPaths unique
	searchPaths = [...new Set(searchPaths)];

	const filenames = searchPaths
		.map(async searchPath => await glob(searchPath + '/**/*.{pas,inc}'));

	return (await Promise.all(filenames)).flat();
}

async function mapPatcher(mapFileName: string, mappings: UnitMappings, outputChannel: vscode.OutputChannel) {
	if (path.extname(mapFileName) !== '.map') {
		vscode.window.showErrorMessage(`Invalid map file: ${mapFileName}`);
		return false;
	}

	if (!fs.existsSync(mapFileName)) {
		vscode.window.showErrorMessage(`Map file not found: ${mapFileName}`);
		return false;
	}

	if (Object.keys(mappings).length === 0) {
		vscode.window.showErrorMessage('No source file mappings specified');
		return false;
	}

	await fs.promises.copyFile(mapFileName, `${mapFileName}.bak`);

	outputChannel.appendLine(`Reading map file...`)
	const contents = await fs.promises.readFile(mapFileName, 'utf8');

	outputChannel.appendLine(`Patching map file...`)
	const patched = contents.replace(/(?<=Line numbers for.*\().*(?=\).*)/gm, (filename: string) => {
		const filenameLowerCase = filename.toLowerCase();

		if (mappings[filenameLowerCase] === undefined) {
			outputChannel.appendLine(`No mapping found for ${filename}...`)
		}

		return mappings[filenameLowerCase] ?? filename;
	});

	outputChannel.appendLine(`Writing map file...`)
	await fs.promises.writeFile(mapFileName, patched);

	return true;
}

async function runDebugger(exePath: string) {
	const debugConfigName = await getDebugConfig(exePath);
	const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined;
	if (workspaceFolder) {
	  const success = await vscode.debug.startDebugging(workspaceFolder, debugConfigName);
	  if (!success) {
		vscode.window.showErrorMessage('Failed to start debugger');
	  }
	} else {
	  vscode.window.showErrorMessage('No workspace folder open');
	}
}

async function getDebugConfig(exePath: string) {
	const debugConfigurations = vscode.workspace.getConfiguration('launch');
	const configurations: any[] = debugConfigurations.get('configurations') || [];
	const debugConfigName = 'Debug Delphi (autogenerated)';
	var config = configurations.find(config => config.name === debugConfigName);

	if (config) {
		return config;
	}

	config = {
		name: `${debugConfigName}`,
		type: 'cppvsdbg',
		request: 'launch',
		program: `${exePath}`,
		args: [],
		stopAtEntry: false,
		cwd: "${workspaceFolder}",
		environment: [],
		console: "externalTerminal"
	};

	configurations.push(config);

	await debugConfigurations.update('configurations', configurations);
}

async function buildDelphi() {
	await runMSBuildProcess([], createOutputChannel('Build Delphi'));
}

async function runDelphi() {
	await runMSBuildProcess([], createOutputChannel('Run Delphi'));
	const dprojFilePath = await getDprojFilePath();
	if (!dprojFilePath) {
		return;
	}

	const exePath = await getExecutableFilePath(dprojFilePath);
	fs.promises.access(exePath, fs.constants.X_OK)
		.then(() => vscode.env.openExternal(vscode.Uri.file(exePath)))
		.catch(() => vscode.window.showErrorMessage(`File does not exist: ${exePath}`));
}

async function cleanDelphi() {
	await runMSBuildProcess(['/t:Clean'], createOutputChannel('Clean Delphi'));
}

async function runMSBuildProcess(extraArgs: readonly string[] = [], outputChannel: vscode.OutputChannel): Promise<void> {
	const rsvarsPath = getConfigString('rsvarsPath');
	if (!rsvarsPath) {
		return;
	}

	const dprojPath = await getDprojFilePath();
	if (!dprojPath) {
		return;
	}

	const args = ['/c', rsvarsPath, '&&', 'MSBuild', dprojPath, ...extraArgs];
	const buildProcess = childProcess.spawn('cmd.exe', args);
	buildProcess.stdout.on('data', (data) => {
		outputChannel.appendLine(data.toString());
	});

	buildProcess.stderr.on('data', (data) => {
		outputChannel.appendLine(data.toString());
	});

	return  new Promise((resolve, reject) => {
		buildProcess.on('close', (code) =>{
			outputChannel.appendLine(`Build process exited with code ${code}`);
			if (code === 0) {
				resolve();
			}
			else {
				reject();
			}
		});
	});
}

async function getExecutableFilePath(dprojFilePath: string): Promise<string> {
	const dprojContent = await fs.promises.readFile(dprojFilePath, 'utf8');
	const dprojXml = await xml2js.parseStringPromise(dprojContent);
	const propGroups = dprojXml.Project.PropertyGroup;
	for (const propGroup of propGroups) {
		if (!(propGroup.DCC_ExeOutput && propGroup.SanitizedProjectName)) {
			continue;
		}

		let relativeOutputDir: string = propGroup.DCC_ExeOutput[0];
		if (relativeOutputDir.includes('$(Platform)') && propGroups[0].Platform[0]) {
			relativeOutputDir = relativeOutputDir.replace('$(Platform)', propGroups[0].Platform[0]._);
		}
		if (relativeOutputDir.includes('$(Config)') && propGroups[0].Config[0]) {
			relativeOutputDir = relativeOutputDir.replace('$(Config)', propGroups[0].Config[0]._);
		}
		const projectName = propGroup.SanitizedProjectName[0];
		const exePath = path.join(relativeOutputDir, `${projectName}.exe`);
		return path.isAbsolute(exePath) ? exePath
										: path.join(path.dirname(dprojFilePath), exePath);
	}

	vscode.window.showErrorMessage(`Unable to obtain output directory/executable name from ${dprojFilePath}.`);
	return '';
}

async function getDprojFilePath(): Promise<string | undefined> {
	const dprojFiles = await vscode.workspace.findFiles('**/*.dproj', '**/node_modules/**', 1);
	if (dprojFiles.length > 0) {
		return dprojFiles[0].fsPath;
	}

	vscode.window.showErrorMessage('No .dproj file found in the current workspace.');
	return undefined;
}

function getConfigString(propertyName: string): string {
	const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
	if (!config) {
		vscode.window.showErrorMessage(`Unable to obtain ${EXTENSION_NAME} configuration.`);
		return '';
	}

	const prop = config.get(propertyName) as string;
	if (!prop) {
		vscode.window.showErrorMessage(`Unable to obtain ${propertyName} from config. Make sure it is set. (Ctrl + ,)`);
		return '';
	}

	return prop;
}

function checkExtension(extensionID: string, description: string, button: string) {
	if (!vscode.extensions.getExtension(extensionID)) {
		vscode.window.showInformationMessage(description, button)
			.then(selection => {
				if (selection === button) {
					vscode.commands.executeCommand('workbench.extensions.installExtension', extensionID);
				}
			});
	}
}

// This method is called when your extension is deactivated
export function deactivate() {}
