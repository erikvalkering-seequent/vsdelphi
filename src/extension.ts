import * as vscode from 'vscode';
import * as childProcess from 'child_process';

// This method is called when anythin from the `contributes` section 
// of the `package.json` is activated or when an event from the 
// `activationEvents` section is triggered
export function activate(context: vscode.ExtensionContext) {
	console.log('Activating VSDelphi extension.');

	const testCmd = vscode.commands.registerCommand('vsdelphi.test', () => {
		console.log('Test VSDelphi command.');
		vscode.window.showInformationMessage('Test VSDelphi command');
	});
	context.subscriptions.push(testCmd);

	const buildCmd = vscode.commands.registerCommand('vsdelphi.build', build);
	context.subscriptions.push(buildCmd);
}

function build() {
	const rsvarsPath = 'C:\\Program Files (x86)\\Embarcadero\\Studio\\22.0\\bin\\rsvars.bat';
	const dprojPath = 'D:\\DelphiProjects\\DelphiHelloWorld\\HelloWorld.dproj';
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

// This method is called when your extension is deactivated
export function deactivate() {}
