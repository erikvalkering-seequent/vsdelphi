import * as vscode from 'vscode';
import * as childProcess from 'child_process';

// The name of the extension as defined in package.json
const EXTENSION_NAME = 'vsdelphi';

// This method is called when anythin from the `contributes` section 
// of the `package.json` is activated or when an event from the 
// `activationEvents` section is triggered
export function activate(context: vscode.ExtensionContext) {
	console.log(`Activating ${EXTENSION_NAME} extension.`);

	const testCmd = vscode.commands.registerCommand(`${EXTENSION_NAME}.test`, test);
	context.subscriptions.push(testCmd);

	const buildCmd = vscode.commands.registerCommand(`${EXTENSION_NAME}.build`, build);
	context.subscriptions.push(buildCmd);
}

function test() {
	const msg = `test ${EXTENSION_NAME} command.`;
	console.log(msg);
	vscode.window.showInformationMessage(msg);
}

async function build() {
	const rsvarsPath = getConfigString('rsvarsPath');
	if (!rsvarsPath) {
		return;
	}

	const dprojPath = await getDprojFilePath();
	if (!dprojPath) {
		return;
	}

	const outputChannel = vscode.window.createOutputChannel('Delphi Build');
	outputChannel.show();
	const buildProcess = childProcess.spawn('cmd.exe', ['/c', rsvarsPath, '&&', 'MSBuild', dprojPath]);

	buildProcess.stdout.on('data', (data) => {
		outputChannel.appendLine(data.toString());
	});

	buildProcess.stderr.on('data', (data) => {
		outputChannel.appendLine(data.toString());
	});

	buildProcess.on('close', (code) =>{
		outputChannel.appendLine(`Build process exited with code ${code}`);
	});
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

// This method is called when your extension is deactivated
export function deactivate() {}
