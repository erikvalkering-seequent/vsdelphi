import * as vscode from 'vscode';
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as xml2js from 'xml2js';
import * as path from 'path';
import { glob } from 'glob';
import ICO from 'icojs';
import * as vsWinReg from '@vscode/windows-registry';

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
  	registerCmd(context, "map2pdb", map2pdb);

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

type UnitMappings = {[key: string]: string};

type DprojPaths = {
	dproj: string,
	dpr: string,
	exe: string,
};

export function isHKEY(key: string): key is vsWinReg.HKEY {
  return ["HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE", "HKEY_CLASSES_ROOT", "HKEY_USERS", "HKEY_CURRENT_CONFIG"].includes(key);
}

export function getGlobalBrowsingPaths() {
	// TODO: don't hardcode Win64
	const regPath = getConfigString('embarcaderoRegistryPath') + '\\Library\\Win64';
	const hive = regPath.split('\\')[0];
	const key = regPath.split('\\').slice(1).join('\\');

	if (!isHKEY(hive)) {
		vscode.window.showErrorMessage(`Invalid registry hive: ${hive}`);
		return [];
	}

	const browsingPath = vsWinReg.GetStringRegKey(hive, key, 'Browsing Path');
	return browsingPath?.split(';') ?? [];
}

async function generateUnitMappings(dprojPaths: DprojPaths) {
	const dprFiles = await parseDprFiles(dprojPaths.dpr);

	const dprojFileDir = path.dirname(dprojPaths.dproj);
	const resolveSearchPath = (searchPath: string) =>
		path.join(dprojFileDir, searchPath)
			.replace(/.*\$\(BDS\)/, getConfigString('embarcaderoInstallDir'))
			.replaceAll('\\', '/');

	const unitSearchPaths = [
		...getGlobalBrowsingPaths(),
		...await parseUnitSearchPaths(dprojPaths.dproj),
	].map(resolveSearchPath);

	return createMappings([
		dprojPaths.dpr,
		...dprFiles,
		...await scanFiles(dprFiles.map(path.dirname).concat(unitSearchPaths)),
	]);
}

async function debugDelphi() {
	if (!fs.existsSync(MAP2PDB_PATH)) {
		vscode.window.showErrorMessage(`Unable to find map2pdb.exe at ${MAP2PDB_PATH}.`);
		return;
	}

	const dprojFilePath = await getDprojFilePath();
	if (!dprojFilePath) {
		return;
	}

	const outputChannel = createOutputChannel('Debug Delphi');
	await runMSBuildProcess(dprojFilePath, [], outputChannel);

	const dprojPaths = await parseDprojPaths(dprojFilePath);
	if (!dprojPaths) {
		return;
	}

	const mapFilePath = changeExt(dprojPaths.exe, '.map');
	const mappings = await generateUnitMappings(dprojPaths);
	if (!await mapPatcher(mapFilePath, mappings, outputChannel)) {
		return;
	}

	const convertProcess = childProcess.spawnSync(MAP2PDB_PATH, ['-bind', mapFilePath]);
	if (convertProcess.error) {
		vscode.window.showErrorMessage(convertProcess.error.message);
	}

	await runDebugger(dprojPaths.exe);
}

async function map2pdb() {
  if (!fs.existsSync(MAP2PDB_PATH)) {
    vscode.window.showErrorMessage(
      `Unable to find map2pdb.exe at ${MAP2PDB_PATH}.`
    );
    return;
  }

  const dprojFilePath = await getDprojFilePath();
  if (!dprojFilePath) {
    return;
  }

  const outputChannel = createOutputChannel("map2pdb");

  const dprojPaths = await parseDprojPaths(dprojFilePath);
  if (!dprojPaths) {
    return;
  }

  const mapFilePath = changeExt(dprojPaths.exe, ".map");
  const mappings = await generateUnitMappings(dprojPaths);
  if (!(await mapPatcher(mapFilePath, mappings, outputChannel))) {
    return;
  }

  const convertProcess = childProcess.spawnSync(MAP2PDB_PATH, [
    "-bind",
    mapFilePath,
  ]);
  if (convertProcess.error) {
    vscode.window.showErrorMessage(convertProcess.error.message);
  }
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
			[path.basename(filename).toLowerCase()]: filename,
		}), {});
}

async function parseUnitSearchPaths(dprojFilePath: string) {
	const dprojContent = await fs.promises.readFile(dprojFilePath, 'utf8');

	return dprojContent
		?.match(/(?<=<DCC_UnitSearchPath>).*(?=<\/DCC_UnitSearchPath>)/)
		?.flatMap(paths => paths.split(';'))
		 .filter(searchPath => searchPath !== '$(DCC_UnitSearchPath)') ?? [];
}

function filterSubdirectories(filePaths: string[]): string[] {
	return filePaths.filter((filePath, index) => {
		return filePaths.every((otherPath, otherIndex) => {
			return otherIndex === index || !filePath.startsWith(otherPath);
		});
	});
}

async function scanFiles(searchPaths: string[]) {
	searchPaths = filterSubdirectories([...new Set(searchPaths)]);

	return await glob(searchPaths.map(searchPath => searchPath + '/**/*.{pas,inc}'));
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

	outputChannel.appendLine(`Reading map file...`);
	const contents = await fs.promises.readFile(mapFileName, 'utf8');

	outputChannel.appendLine(`Patching map file...`);
	const patched = contents.replace(/(?<=Line numbers for.*\().*(?=\).*)/gm, (filename: string) => {
		const filenameLowerCase = filename.toLowerCase();

		if (mappings[filenameLowerCase] === undefined) {
			outputChannel.appendLine(`No mapping found for ${filename}...`);
		}

		return mappings[filenameLowerCase] ?? filename;
	});

	outputChannel.appendLine(`Writing map file...`);
	await fs.promises.writeFile(mapFileName, patched);

	return true;
}

async function runDebugger(exePath: string) {
	const debugConfig = await getDebugConfig(exePath);
	const workspaceFolder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined;
	if (workspaceFolder) {
	  const success = await vscode.debug.startDebugging(workspaceFolder, debugConfig);
	  if (!success) {
		vscode.window.showErrorMessage('Failed to start debugger');
	  }
	} else {
	  vscode.window.showErrorMessage('No workspace folder open');
	}
}

async function getDebugConfig(exePath: string) {
	const exeName = path.basename(exePath);
	const debugConfigurations = vscode.workspace.getConfiguration('launch');
	const configurations: any[] = debugConfigurations.get('configurations') || [];
	// TODO: should embed the configuration (e.g. Debug/Release; Win32/Win64) into the config name
	// TODO: not only that, but it should also perform a search on all of the fields that it would generate.
	//       for example, if the dproj is configured such that it writes the resulting .exe in a different
	//       directory, then the existing config will use a wrong executable
	const debugConfigName = `${exeName} (autogenerated by VSDelphi)`;
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

	return config;
}

async function buildDelphi() {
	const dprojFilePath = await getDprojFilePath();
	if (!dprojFilePath) {
		return;
	}

	await runMSBuildProcess(dprojFilePath, [], createOutputChannel('Build Delphi'));
}

async function runDelphi() {
	const dprojFilePath = await getDprojFilePath();
	if (!dprojFilePath) {
		return;
	}

	await runMSBuildProcess(dprojFilePath, [], createOutputChannel('Run Delphi'));

	const dprojPaths = await parseDprojPaths(dprojFilePath);
	if (!dprojPaths) {
		return;
	}

	fs.promises.access(dprojPaths.exe, fs.constants.X_OK)
		.then(() => vscode.env.openExternal(vscode.Uri.file(dprojPaths.exe)))
		.catch(() => vscode.window.showErrorMessage(`File does not exist: ${dprojPaths.exe}`));
}

async function cleanDelphi() {
	const dprojFilePath = await getDprojFilePath();
	if (!dprojFilePath) {
		return;
	}

	await runMSBuildProcess(dprojFilePath, ['/t:Clean'], createOutputChannel('Clean Delphi'));
}

async function runMSBuildProcess(dprojPath: string, extraArgs: readonly string[] = [], outputChannel: vscode.OutputChannel): Promise<void> {
	const rsvarsPath = getConfigString('rsvarsPath');
	if (!rsvarsPath) {
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

	return new Promise((resolve, reject) => {
		buildProcess.on('close', (code) => {
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

async function parseDprojPaths(dprojFilePath: string): Promise<DprojPaths | undefined> {
	const dprojContent = await fs.promises.readFile(dprojFilePath, 'utf8');
	const dprojXml = await xml2js.parseStringPromise(dprojContent);
	const propGroups = dprojXml.Project.PropertyGroup;

	let dpr = undefined;

	for (const propGroup of propGroups) {
		if (propGroup.MainSource) {
			const mainSource = propGroup.MainSource[0];
			dpr = path.join(path.dirname(dprojFilePath), mainSource);
			break;
		}
	}

	if (dpr === undefined) {
		vscode.window.showErrorMessage(`Unable to obtain main source file from ${dprojFilePath}.`);
		return undefined;
	}

	let exe = undefined;
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
		exe = path.isAbsolute(exePath) ? exePath
											 : path.join(path.dirname(dprojFilePath), exePath);
	}

	if (exe === undefined) {
		// Fallback to dpr file name if no exe name is specified
		exe = changeExt(dpr, '.exe');
	}

	return {
		dpr,
		exe,
		dproj: dprojFilePath,
	};
}

async function parseIconPath(dprojFilePath: string): Promise<vscode.Uri | undefined> {
	const dprojContent = fs.readFileSync(dprojFilePath, 'utf8');
	const makeUri = async (iconPath: string) => {
		if (!fs.existsSync(iconPath)) {
			return undefined;
		}

		return await convertIcoToUriBuffer(iconPath);
	};

	const BDS = getConfigString('embarcaderoInstallDir');
	const defaultIcon = 'delphi_PROJECTICON.ico';
	const defaultIconPath = path.join(BDS, 'bin', defaultIcon);

	const iconRegex = /<Icon_MainIcon.*>(.*?)<\/Icon_MainIcon>/g;
	const iconPaths: string[] = [];
	let match;

	while ((match = iconRegex.exec(dprojContent)) !== null) {
		const iconPath = match[1].trim();
		if (iconPath.startsWith('$(')) {
			continue;
		}
		iconPaths.push(iconPath);
	}

	if (iconPaths.length === 0) {
		return makeUri(defaultIconPath);
	}

	if (iconPaths.length === 1) {
		return makeUri(path.join(path.dirname(dprojFilePath), iconPaths[0]));
	}

	const remainingIcons = iconPaths.filter((iconPath) => iconPath !== defaultIcon);
	if (remainingIcons.length === 0) {
		return makeUri(defaultIconPath);
	}

	const shortestIcon = remainingIcons.reduce((shortest, iconPath) => {
		return iconPath.length < shortest.length ? iconPath : shortest;
	});

	return makeUri(path.join(path.dirname(dprojFilePath), shortestIcon));
}

async function convertIcoToPngBuffer(icoFilePath: string): Promise<Buffer> {
	const icoBuffer = await fs.promises.readFile(icoFilePath);
	const icoData = await ICO.parse(icoBuffer);

	return Buffer.from(icoData[0].buffer);
}

async function convertIcoToUriBuffer(icoFilePath: string): Promise<vscode.Uri> {
	const pngBuffer = await convertIcoToPngBuffer(icoFilePath);
	const base64Data = pngBuffer.toString('base64');
	const uriBuffer = Buffer.from(base64Data, 'base64');

	return vscode.Uri.parse(`data:image/png;base64,${uriBuffer.toString('base64')}`);
}

async function getDprojFilePath(): Promise<string | undefined> {
	const dprojFiles = await vscode.workspace.findFiles('**/*.dproj', '**/node_modules/**');
	if (dprojFiles.length === 0) {
		vscode.window.showErrorMessage('No .dproj file found in the current workspace.');
		return undefined;
	}

	if (dprojFiles.length === 1) {
		return dprojFiles[0].fsPath;
	}

	// Sort the dprojFiles array in a deterministic order
	dprojFiles.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

	// TODO: in case a dproj or dpr is the current buffer, select it as the default
	// TODO: remember the previous selection and make it the default
	const options: vscode.QuickPickOptions = {
		canPickMany: false,
		placeHolder: 'Multiple .dproj files found. Please select one.'
	};

	const fileItems: vscode.QuickPickItem[] = await Promise.all(
		dprojFiles.map(async file => ({
			label: path.basename(file.fsPath),
			description: path.dirname(file.fsPath),
			iconPath: await parseIconPath(file.fsPath),
		})));

	const selectedFile = await vscode.window.showQuickPick(fileItems, options);
	if (selectedFile) {
		return path.join(selectedFile.description!, selectedFile.label);
	}

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
