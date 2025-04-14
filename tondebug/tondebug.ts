import * as fs from "fs";
import process from "process";
import { Cell, toNano } from "@ton/core";
import { compileFunc } from "@ton-community/func-js";
import * as readline from 'readline';
import { Blockchain, createShardAccount } from "@ton/sandbox";
import {randomAddress} from "@ton/test-utils";

interface ContractState {
    balance?: bigint;
    code?: Cell;
    data?: Cell;
}

interface ValidationResult {
    isValid: boolean;
    state?: ContractState;
}

interface DebugConsoleOptions {
    initialState?: ContractState;
    // еще будет message queue
}

async function compileContract(contractPath: string): Promise<boolean> {
      console.log(
        "================================================================="
      );
      console.log(
        "Compile script is running, let's find some FunC code to compile at " + contractPath
      );
    
      const compileResult = await compileFunc({
        targets: [contractPath],
        sources: (x) => fs.readFileSync(x).toString("utf8"),
      });
    
      if (compileResult.status === "error") {
        console.log(" - OH NO! Compilation Errors! The compiler output was:");
        console.log(`\n${compileResult.message}`);
        return false;
      }
    
      console.log(" - Compilation successful!");
      
      if (!fs.existsSync('tmp')) {
        fs.mkdirSync('tmp');
        console.log(' - Created tmp directory');
    }

      const hexArtifact = `tmp/tondebug.compiled.json`;
    
      fs.writeFileSync(
        hexArtifact,
        JSON.stringify({
          hex: Cell.fromBoc(Buffer.from(compileResult.codeBoc, "base64"))[0]
            .toBoc()
            .toString("hex"),
        })
      );
    
      console.log(" - Compiled code saved to " + hexArtifact);

      console.log(
        "================================================================="
      );

      return true;
}

async function validateInitState(initStatePath: string): Promise<ValidationResult> {
    const state = JSON.parse(fs.readFileSync(initStatePath, 'utf-8'));

    const validFields = ['balance', 'code', 'data'];
    const invalidFields = Object.keys(state).filter(
        key => !validFields.includes(key)
    );
        
    if (invalidFields.length > 0) {
        console.log(`Error: Unknown fields in state file: ${invalidFields.join(', ')}`);
        return {isValid: false};
    }
        
    if (!state.balance && !state.code && !state.data) {
        console.log('Error: state file must contain at least one of: balance, code, data');
        return {isValid: false};
    }
    
    const resultState: ContractState = {};
    if (state.balance) {
        resultState.balance = BigInt(state.balance);
    }
    if (state.code) {
        resultState.code = Cell.fromBoc(Buffer.from(state.code, 'hex'))[0];
    }
    if (state.data) {
        resultState.data = Cell.fromBoc(Buffer.from(state.data, 'hex'))[0];
    }

    return {
        isValid: true,
        state: resultState
    };
}

async function startDebugConsole(options: DebugConsoleOptions = {}) {
    console.log("TON Debug Console started. Type 'exit' to quit.");
    console.log("Currently available commands:");
    console.log("  exit - Quit the debugger");
    console.log("  help - Show available commands and their descriptions");
    console.log("  show state - Show current state");
    console.log("  run get-method [--name <method_name>] - Run contract method");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: 'tondebug> '
    });

    const hexData = fs.readFileSync('./tmp/tondebug.compiled.json', 'utf-8');
    const { hex } = JSON.parse(hexData);

    const blockchain = await Blockchain.create();
    const codeCell = Cell.fromBoc(Buffer.from(hex, "hex"))[0];

    const initialState: ContractState = {};

    if (options.initialState) {
        console.log("Initial state detected!");
        if (options.initialState.balance) {
            initialState.balance = options.initialState.balance;
        }
        if (options.initialState.code) {
            initialState.code = options.initialState.code;
        }
        if (options.initialState.data) {
            initialState.data = options.initialState.data;
        }
    } else {
        console.log("No initial state provided");
    }
    
    const testContractAddress = randomAddress();

    await blockchain.setShardAccount(
        testContractAddress,
        createShardAccount({
            address: testContractAddress,
            code: initialState.code ?? codeCell,
            data: initialState.data ?? new Cell(),
            balance: initialState.balance ?? toNano('1'),
        })
    );
    
    const provider = blockchain.provider(testContractAddress);

    rl.prompt();

    rl.on('line', async (line) => {
        const input = line.trim().toLowerCase();
        
        switch (true) {
            case input === 'exit':
                console.log("Exiting...");
                rl.close();
                break;
            case input === 'help':
                console.log("Available commands:");
                console.log("  exit - Quit the debugger");
                console.log("  help - Show this help");
                console.log("  show state - Show current state");
                console.log("  run get-method [--name <method_name>] - Run contract method");
                break;
            case input === 'show state':
                const currentState = await provider.getState();
                console.log(`- Balance: ${currentState.balance.toString()}`);
                console.log(`- Extracurrency: ${
                    currentState.extracurrency 
                        ? currentState.extracurrency.toString() 
                        : 'none'
                }`);
                if (currentState.last) {
                    console.log(`- Last Transaction:`);
                    console.log(`  * LT: ${currentState.last.lt.toString()}`);
                    console.log(`  * Hash: ${currentState.last.hash.toString('hex')}`);
                } else {
                    console.log("- Last Transaction: none");
                }
                console.log("- Contract State:");
                switch (currentState.state.type) {
                    case 'uninit':
                        console.log("  * Type: Uninitialized");
                        break;
                    case 'active':
                        console.log("  * Type: Active");
                        console.log(`  * Code: ${
                            currentState.state.code 
                                ? currentState.state.code.toString('hex') 
                                : 'none'
                        }`);
                        console.log(`  * Data: ${
                            currentState.state.data 
                                ? currentState.state.data.toString('hex') 
                                : 'none'
                        }`);
                        break;
                    case 'frozen':
                        console.log("  * Type: Frozen");
                        console.log(`  * State Hash: ${
                            currentState.state.stateHash.toString('hex')
                        }`);
                        break;
                }
                break;
            case input.startsWith('run get-method'):
                const methodNameMatch = line.match(/run get-method --name (\w+)/);
                if (!methodNameMatch) {
                    console.log('Error: Please specify method name');
                    console.log('Usage: run get-method --name NAME');
                    break;
                }
                const methodName = methodNameMatch[1];
                
                // надо подумать как универсально выводить
                try {
                    const data = await blockchain.runGetMethod(testContractAddress, methodName, []);
                    console.log(`Method "${methodName}" execution result:`);
                    console.log(`  * Exit Code: ${data.exitCode}`);
                    console.log(`  * Gas Used: ${data.gasUsed}`);
                    console.log(`  * Address from stack: ${data.stackReader.readAddress()}`);
                } catch (err) {
                    console.log(`Error executing method "${methodName}":`, 
                        err instanceof Error ? err.message : err);
                }
                
                break;
            case input === '':
                break;
            default:
                console.log(`Unknown command: "${input}". Type "help" for available commands.`);
                break;
        }

        if (input !== 'exit') {
            rl.prompt();
        }
    }).on('close', () => {
        process.exit(0);
    });
}

async function main() {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.length === 0) {
        printHelp();
        process.exit(0);
    }

    const contractIndex = args.indexOf('--contract');
    const initStateIndex = args.indexOf('--init-state');

    if (contractIndex === -1 || contractIndex === args.length - 1) {
        console.log('Error: --contract flag requires a path argument');
        console.log(
            "================================================================="
        );
        printHelp();
        process.exit(0);
    }

    const contractPath = args[contractIndex + 1];
    let initStatePath: string | null = null;

    if (initStateIndex !== -1) {
        if (initStateIndex === args.length - 1) {
            console.log('Error: --init-state flag requires a path argument');
            console.log(
                "================================================================="
            );
            printHelp();
            process.exit(0);
        }
        initStatePath = args[initStateIndex + 1];
    }

    if (!fs.existsSync(contractPath)) {
        console.log('Error: contract file not found at: ' + contractPath);
        console.log(
            "================================================================="
        );
        printHelp();
        process.exit(0);
    }

    const compilationSuccess = await compileContract(contractPath);
    if (!compilationSuccess) {
        process.exit(0);
    }

    let debugConsoleOptions: { initialState?: ContractState } = {};

    if (initStatePath) {
        if (!fs.existsSync(initStatePath)) {
            console.log(`Error: Initial state file not found at: ${initStatePath}`);
            console.log(
                "================================================================="
            );
            printHelp();
            process.exit(0);
        }

        const validationResult = await validateInitState(initStatePath);
        
        if (!validationResult.isValid) {
            console.log('Error: Invalid initial state file');
            console.log(
                "================================================================="
            );
            printHelp();
            process.exit(0);
        }

        if (validationResult.state) {
            debugConsoleOptions.initialState = validationResult.state;
            console.log('Initial state successfully validated');
        }
    }

    console.log(
        "================================================================="
    );

    await startDebugConsole(debugConsoleOptions);
}

function printHelp() {
    console.log(`
TON Debugger - Interactive debug console for FunC contracts

Usage:
  tondebug --contract <path> [--init-state <path>] [--queue <path>] [--help]

Options:
  --contract <path>    Path to FunC contract file (required)
  --init-state <path>  Path to initial contract state (json) (optional)
  --queue <path>       Path to initial message queue (json) (optional)
  --help               Show this help message

Example:
  tondebug --contract ./contracts/main.fc --init-state ./states/initial_state.json
`);

console.log(
    "================================================================="
);
}

main().catch(console.error);