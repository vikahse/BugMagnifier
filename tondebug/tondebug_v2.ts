import * as fs from "fs";
import * as readline from "readline";
import { beginCell, Cell, Address, toNano, CurrencyCollection } from "@ton/core";
import { compileFunc } from "@ton-community/func-js";
import { Blockchain, createShardAccount, SandboxContract } from "@ton/sandbox";
import { randomAddress } from "@ton/test-utils";
import ts from 'typescript';

interface ContractState {
    balance?: bigint;
    code?: Cell;
    data?: Cell;
    lastTransaction?: {
        lt: string;
        hash: string;
    };
}

interface Message {
    id: number;
    type: 'internal' | 'external-in' | 'external-out';
    body: Cell;
    value?: {
      coins: bigint;
      extraCurrencies?: Cell | null;
    };
    name?: string;
}

interface Transaction {
    hash: string;
    message: Message;
    status: 'success' | 'failed';
    stateChanges: ContractState;
}

interface DebugConsoleOptions {
    initialState?: ContractState;
    initialQueue?: Message[];
}

// TON Debug Console
class TONDebugConsole {
    private blockchain!: Blockchain;
    private contractAddress!: Address;
    private queue: Message[] = [];
    private executedMessages: Message[] = [];
    private transactions: Transaction[] = [];
    private stateHistory: ContractState[] = [];
    private rl: readline.Interface;
    private provider!: SandboxContract<any>;
    private scriptFn: ((q: Message[]) => void) | null = null;

    // Конструктор дебагера
    constructor(
        private options: DebugConsoleOptions,
        private codeCell: Cell
    ) {
        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: 'tondebug> '
        });
    }

    async initialize() {
        this.blockchain = await Blockchain.create();
        this.contractAddress = randomAddress();
        const hexData = fs.readFileSync('./tmp/tondebug.compiled.json', 'utf-8');
        const { hex } = JSON.parse(hexData);
        const codeCell = Cell.fromBoc(Buffer.from(hex, "hex"))[0];

        const initialState = this.options.initialState || {
            balance: toNano('1'),
            code: this.codeCell,
            data: new Cell()
        };

        await this.blockchain.setShardAccount(
            this.contractAddress,
            createShardAccount({
                address: this.contractAddress,
                code: initialState.code ?? codeCell,
                data: initialState.data ?? new Cell(),
                balance: initialState.balance ?? toNano('1'),
            })
        );

        this.provider = this.blockchain.provider(this.contractAddress);

        if (this.options.initialQueue) {
            this.queue = this.options.initialQueue;
        }

        const currentState = await this.getCurrentState();
        this.stateHistory.push(currentState);

        console.log("TON Debug Console started. Type 'help' for commands list.");
        this.rl.prompt();

        this.rl.on('line', async (line) => {
            await this.handleCommand(line.trim());
            this.rl.prompt();
        }).on('close', () => {
            console.log("Exiting TON Debug Console");
            process.exit(0);
        });
    }


    // Текущее состояние
    private async getCurrentState(): Promise<ContractState> {
        const state = await this.provider.getState();
        
        return {
            balance: state.balance,
            code: state.state.type === 'active' ? state.state.code : undefined,
            data: state.state.type === 'active' ? state.state.data : undefined,
            lastTransaction: state.last ? {
                lt: state.last.lt.toString(),
                hash: state.last.hash.toString('hex')
            } : undefined
        };
    }

    // Сохранить состояние
    private async saveState(path: string): Promise<void> {
        const state = await this.getCurrentState();
        const serialized = {
            balance: state.balance?.toString(),
            code: state.code?.toBoc().toString('hex'),
            data: state.data?.toBoc().toString('hex')
        };
        await fs.promises.writeFile(path, JSON.stringify(serialized, null, 2));
        console.log(`State saved to ${path}`);
    }


    // Обработать следующее сообщение
    private async executeMessage(message: Message): Promise<boolean> {
      console.log(`\nExecuting message ${message.id}: ${message.name || 'unnamed'}`);
      console.log(`Type: ${message.type}, Value: ${message.value || '0'}`);

      try {
        const result = await this.blockchain.sendMessage({
            info: { 
                type: message.type || 'internal',
                dest: this.contractAddress,
                value: message.value || { coins: 0n, extraCurrencies: null }
            },
            body: message.body
        });

        if (!result.transactions || result.transactions.length === 0) {
            throw new Error('No transactions were produced');
        }
        
        const transactionResult = result.transactions[0];
        const newState = await this.getCurrentState();
        
        const transaction: Transaction = {
            hash: transactionResult.hash().toString('hex'),
            message: message,
            status: transactionResult.description.type === 'generic' ? 'success' : 'failed',
            stateChanges: newState
        };
    
        this.transactions.push(transaction);
        this.executedMessages.push(message);
        this.stateHistory.push(newState);
    
        console.log(`Message executed successfully`);
        console.log(`Transaction LT: ${transactionResult.lt}`);
        console.log(`New balance: ${newState.balance}`);
        return true;
    } catch (err) {
        console.error(`Failed to execute message: ${err instanceof Error ? err.message : String(err)}`);
        return false;
    }
  }


    // Работа с командами в консоли
    private async handleCommand(input: string): Promise<void> {
        const args = input.split(/\s+/);
        const command = args[0];
        const params = args.slice(1);

        try {
            switch (command) {
                case 'help':
                    this.showHelp();
                    break;
                case 'run':
                    await this.handleRunCommand(params);
                    break;
                case 'continue':
                    await this.runAllMessages();
                    break;
                case 'show':
                    await this.handleShowCommand(params);
                    break;
                case 'load':
                    await this.handleLoadCommand(params);
                    break;
                case 'save':
                    await this.handleSaveCommand(params);
                    break;
                case 'diff':
                    await this.diffStates(params[0], params[1]);
                    break;
                case 'queue':
                    await this.handleQueueCommand(params);
                    break;
                case 'set':
                    await this.handleSetCommand(params);
                    break;
                case 'add':
                    await this.addMessages(params[0]);
                    break;
                case 'delete':
                    await this.deleteMessage(parseInt(params[1]));
                    break;
                case 'script':
                    await this.handleScriptCommand(params);
                    break;
                case 'exit':
                    this.rl.close();
                    break;
                case '':
                    break;
                default:
                    console.log(`Unknown command: "${command}". Type "help" for available commands.`);
            }
        } catch (err) {
            console.error(`Command error: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private showHelp(): void {
        console.log('\nAvailable commands:');
        console.log('  help - Show this help message');
        console.log('  run next - Execute next message from queue');
        console.log('  run message <id> - Execute specific message by ID');
        console.log('  run get-method --name <method> - Call contract method');
        console.log('  continue - Execute all remaining messages');
        console.log('  show state - Show current contract state');
        console.log('  show transactions - List executed transactions');
        console.log('  show message log - Show executed messages log');
        console.log('  load state <path> - Load state from file');
        console.log('  save state <path> - Save current state to file');
        console.log('  diff <path1> <path2> - Compare two state files');
        console.log('  queue list - Show message queue');
        console.log('  set queue --order <reverse/random> - Reorder queue');
        console.log('  add messages <path> - Add messages from JSON file');
        console.log('  delete message <id> - Remove message from queue');
        console.log('  script load <path> - Load custom queue script');
        console.log('  script run - Execute custom queue script');
        console.log('  exit - Exit the debug console\n');
    }

    private async handleRunCommand(params: string[]): Promise<void> {
        if (params.length === 0) {
            console.log('Usage: run <next|message <id>|get-method --name <method>>');
            return;
        }

        switch (params[0]) {
            case 'next':
                await this.runNextMessage();
                break;
            case 'message':
                if (params.length < 2) {
                    console.log('Please specify message ID');
                    return;
                }
                await this.runSpecificMessage(parseInt(params[1]));
                break;
            case 'get-method':
                if (params.length < 3 || params[1] !== '--name') {
                    console.log('Usage: run get-method --name <method>');
                    return;
                }
                await this.runGetMethod(params[2]);
                break;
            default:
                console.log('Invalid run command');
        }
    }

    // Обработать следующее сообщение
    private async runNextMessage(): Promise<void> {
      if (this.queue.length === 0) {
          console.log('Queue is empty');
          return;
      }

      const message = this.queue.shift()!;
      await this.executeMessage(message);
  }


    // Обработать конкретное сообщение
    private async runSpecificMessage(id: number): Promise<void> {
        const index = this.queue.findIndex(m => m.id === id);
        if (index === -1) {
            console.log(`Message with ID ${id} not found in queue`);
            return;
        }

        const message = this.queue.splice(index, 1)[0];
        await this.executeMessage(message);
    }


    // Доделать все сообщения
    private async runAllMessages(): Promise<void> {
        if (this.queue.length === 0) {
            console.log('No messages in queue');
            return;
        }

        console.log(`Executing ${this.queue.length} messages...`);
        while (this.queue.length > 0) {
            await this.runNextMessage();
        }
        console.log('All messages executed');
    }

    private async runGetMethod(methodName: string): Promise<void> {
      const methodNameMatch = methodName.match(/run get-method --name (\w+)/);
      if (!methodNameMatch) {
          console.log('Error: Please specify method name');
          console.log('Usage: run get-method --name NAME');
          return;
      }

      try {
          const data = await this.blockchain.runGetMethod(this.contractAddress, methodName, []);
          console.log(`Method "${methodName}" execution result:`);
          console.log(`  * Exit Code: ${data.exitCode}`);
          console.log(`  * Gas Used: ${data.gasUsed}`);
          console.log(`  * Address from stack: ${data.stackReader.readAddress()}`);
      } catch (err) {
          console.log(`Error executing method "${methodName}":`, 
              err instanceof Error ? err.message : err);
      }
    }

    private async handleShowCommand(params: string[]): Promise<void> {
      if (params.length === 0) {
          console.log('Usage: show <state|transactions|message log>');
          return;
      }

      switch (params[0]) {
          case 'state':
              await this.showState();
              break;
          case 'transactions':
              this.showTransactions();
              break;
          case 'message':
              if (params[1] === 'log') {
                  this.showMessageLog();
              }
              break;
          default:
              console.log('Invalid show command');
      }
  }

    private async showState(): Promise<void> {
        const state = await this.getCurrentState();
        
        console.log('\nCurrent contract state:');
        console.log(`Balance: ${state.balance}`);
        console.log(`Code: ${state.code ? 'present' : 'none'}`);
        console.log(`Data: ${state.data ? 'present' : 'none'}`);
        
        if (state.lastTransaction) {
            console.log('\nLast transaction:');
            console.log(`LT: ${state.lastTransaction.lt}`);
            console.log(`Hash: ${state.lastTransaction.hash}`);
        } else {
            console.log('\nNo transactions yet');
        }
    }

    private showTransactions(): void {
        if (this.transactions.length === 0) {
            console.log('No transactions yet');
            return;
        }

        console.log(`\nTransaction history (${this.transactions.length}):`);
        this.transactions.forEach((tx, i) => {
            console.log(`\n${i + 1}. ${tx.hash}`);
            console.log(`Message: ${tx.message.id} (${tx.message.name || 'unnamed'})`);
            console.log(`Status: ${tx.status}`);
            console.log(`Balance change: ${tx.stateChanges.balance}`);
        });
    }

    private showMessageLog(): void {
        if (this.executedMessages.length === 0) {
            console.log('No messages executed yet');
            return;
        }

        console.log(`\nExecuted messages (${this.executedMessages.length}):`);
        this.executedMessages.forEach((msg, i) => {
            console.log(`${i + 1}. ID: ${msg.id}, Name: ${msg.name || 'unnamed'}, Type: ${msg.type}`);
        });
    }

    private async handleLoadCommand(params: string[]): Promise<void> {
        if (params.length < 2 || params[0] !== 'state') {
            console.log('Usage: load state <path>');
            return;
        }

        const path = params[1];
        if (!fs.existsSync(path)) {
            console.log(`File not found: ${path}`);
            return;
        }

        try {
            const data = await fs.promises.readFile(path, 'utf-8');
            const state = JSON.parse(data);
            
            if (state.balance) {
                const balance = BigInt(state.balance);
                await this.blockchain.setShardAccount(
                    this.contractAddress,
                    createShardAccount({
                        address: this.contractAddress,
                        code: state.code ? Cell.fromBoc(Buffer.from(state.code, 'hex'))[0] : this.codeCell,
                        data: state.data ? Cell.fromBoc(Buffer.from(state.data, 'hex'))[0] : new Cell(),
                        balance: balance
                    })
                );
                
                console.log(`State loaded. New balance: ${balance}`);
            } else {
                console.log('State loaded (no balance change)');
            }
            
            this.stateHistory.push(await this.getCurrentState());
        } catch (err) {
            console.error(`Failed to load state: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private async handleSaveCommand(params: string[]): Promise<void> {
        if (params.length < 2 || params[0] !== 'state') {
            console.log('Usage: save state <path>');
            return;
        }

        await this.saveState(params[1]);
    }

    private async diffStates(path1: string, path2: string): Promise<void> {
        if (!fs.existsSync(path1) || !fs.existsSync(path2)) {
            console.log('One or both state files not found');
            return;
        }

        try {
            const [state1, state2] = await Promise.all([
                fs.promises.readFile(path1, 'utf-8').then(JSON.parse),
                fs.promises.readFile(path2, 'utf-8').then(JSON.parse)
            ]);

            console.log('\nComparing states:');
            this.compareObjects(state1, state2);
        } catch (err) {
            console.error(`Failed to compare states: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private compareObjects(obj1: any, obj2: any, path: string = ''): void {
        const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);

        for (const key of allKeys) {
            const currentPath = path ? `${path}.${key}` : key;
            
            if (!(key in obj1)) {
                console.log(`+ ${currentPath}: ${JSON.stringify(obj2[key])} (added)`);
                continue;
            }

            if (!(key in obj2)) {
                console.log(`- ${currentPath}: ${JSON.stringify(obj1[key])} (removed)`);
                continue;
            }

            if (typeof obj1[key] === 'object' && typeof obj2[key] === 'object' && 
                obj1[key] !== null && obj2[key] !== null) {
                this.compareObjects(obj1[key], obj2[key], currentPath);
            } else if (obj1[key] !== obj2[key]) {
                console.log(`~ ${currentPath}:`);
                console.log(`  - ${JSON.stringify(obj1[key])}`);
                console.log(`  + ${JSON.stringify(obj2[key])}`);
            }
        }
    }

    private async handleQueueCommand(params: string[]): Promise<void> {
        if (params.length === 0 || params[0] !== 'list') {
            console.log('Usage: queue list');
            return;
        }

        this.showQueue();
    }

    private showQueue(): void {
        if (this.queue.length === 0) {
            console.log('Queue is empty');
            return;
        }

        console.log(`\nMessages in queue (${this.queue.length}):`);
        this.queue.forEach(msg => {
            console.log(`ID: ${msg.id}, Name: ${msg.name || 'unnamed'}, Type: ${msg.type}`);
        });
    }

    private async handleSetCommand(params: string[]): Promise<void> {
        if (params.length < 3 || params[0] !== 'queue' || params[1] !== '--order') {
            console.log('Usage: set queue --order <reverse/random>');
            return;
        }

        const order = params[2];
        switch (order) {
            case 'reverse':
                this.queue.reverse();
                console.log('Queue order reversed');
                break;
            case 'random':
                this.shuffleQueue();
                console.log('Queue order randomized');
                break;
            default:
                console.log(`Unknown order: ${order}. Use 'reverse' or 'random'`);
        }
    }

    private shuffleQueue(): void {
        for (let i = this.queue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        }
    }

    private async addMessages(path: string): Promise<void> {
        if (!fs.existsSync(path)) {
            console.log(`File not found: ${path}`);
            return;
        }

        try {
            const data = await fs.promises.readFile(path, 'utf-8');
            const messages: Message[] = JSON.parse(data);
            
            // Assign IDs if not present
            let maxId = this.queue.length > 0 
                ? Math.max(...this.queue.map(m => m.id)) 
                : 0;

            messages.forEach(msg => {
                if (msg.id === undefined) {
                    msg.id = ++maxId;
                }
                this.queue.push(msg);
            });

            console.log(`Added ${messages.length} messages to queue`);
            this.showQueue();
        } catch (err) {
            console.error(`Failed to add messages: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private async deleteMessage(id: number): Promise<void> {
        const initialLength = this.queue.length;
        this.queue = this.queue.filter(m => m.id !== id);

        if (this.queue.length === initialLength) {
            console.log(`Message with ID ${id} not found in queue`);
        } else {
            console.log(`Message ${id} removed from queue`);
            this.showQueue();
        }
    }

    private async handleScriptCommand(params: string[]): Promise<void> {
        if (params.length === 0) {
            console.log('Usage: script <load <path>|run>');
            return;
        }

        switch (params[0]) {
            case 'load':
                if (params.length < 2) {
                    console.log('Please specify script path');
                    return;
                }
                await this.loadScript(params[1]);
                break;
            case 'run':
                await this.runScript();
                break;
            default:
                console.log('Invalid script command');
        }
    }

    private async loadScript(filePath: string): Promise<void> {
        if (!fs.existsSync(filePath)) {
            console.log(`File not found: ${filePath}`);
            return;
        }

        try {
            let script = await fs.promises.readFile(filePath, 'utf-8');
            
            if (filePath.endsWith('.ts')) {
                script = ts.transpileModule(script, {
                  compilerOptions: {
                    module: ts.ModuleKind.CommonJS,
                    target: ts.ScriptTarget.ES2020
                  }
                }).outputText;
            }

            if (/export\s+function\s+modifyQueue/.test(script)) {
                script = script
                  .replace(/export\s+function\s+modifyQueue/, 'function modifyQueue')
                  + '\nmodule.exports.modifyQueue = modifyQueue;';
            }
          
            const module = { exports: {} as Record<string, any> };
            const wrapped =
                `(function (exports, module, require) { ${script}\n})(module.exports, module, require);`;
            eval(wrapped);
          
            if (typeof module.exports.modifyQueue !== 'function') {
                console.error('Script must export function "modifyQueue(queue)"');
                return;
            }
            this.scriptFn = module.exports.modifyQueue as (q: Message[]) => void;
            console.log(`Script loaded from ${filePath}`);
        } catch (err) {
            console.error(`Failed to load script: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private async runScript(): Promise<void> {
        if (!this.scriptFn) {
            console.warn('No script loaded – nothing to run');
            return;
        }
        console.log('Running custom queue script');
        await this.scriptFn(this.queue);
        console.log('Queue after script execution:');
        this.showQueue();
    }
}

async function compileContract(contractPath: string): Promise<Cell> {
    const compileResult = await compileFunc({
      targets: [contractPath],
      sources: (x) => fs.readFileSync(x).toString("utf8"),
    });
  
    if (compileResult.status === "error") {
      console.log(" - OH NO! Compilation Errors! The compiler output was:");
      console.log(`\n${compileResult.message}`);
      throw new Error("Compilation failed");
    }
  
    const codeCell = Cell.fromBoc(Buffer.from(compileResult.codeBoc, "base64"))[0];
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

    return codeCell;
}

async function validateInitState(path: string): Promise<ContractState> {
    const state = JSON.parse(fs.readFileSync(path, 'utf-8'));

    const validFields = ['balance', 'code', 'data'];
    const invalidFields = Object.keys(state).filter(
        key => !validFields.includes(key)
    );
        
    if (invalidFields.length > 0) {
        throw new Error(`Invalid fields in state file: ${invalidFields.join(', ')}`);
    }
        
    if (!state.balance && !state.code && !state.data) {
      throw new Error('State file must contain at least one of: balance, code, data');
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

    return resultState;
}

async function loadMessageQueue(path: string): Promise<Message[]> {
    if (!fs.existsSync(path)) {
        throw new Error(`Queue file not found: ${path}`);
    }

    const data = fs.readFileSync(path, 'utf-8');
    const messages = JSON.parse(data);

    if (!Array.isArray(messages)) {
        throw new Error('Queue file must contain an array of messages');
    }

    return messages.map((msg, i) => ({
        id: msg.id || i + 1,
        type: msg.type || 'external',
        body: msg.body ? Cell.fromBoc(Buffer.from(msg.body, 'hex'))[0] : new Cell(),
        value: msg.value,
        name: msg.name
    }));
}

async function main() {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.length === 0) {
        printHelp();
        return;
    }

    const contractIndex = args.indexOf('--contract');
    if (contractIndex === -1 || contractIndex === args.length - 1) {
        console.error('Error: --contract flag requires a path argument');
        printHelp();
        return;
    }

    const contractPath = args[contractIndex + 1];
    if (!fs.existsSync(contractPath)) {
        console.error(`Contract file not found: ${contractPath}`);
        return;
    }

    const initStateIndex = args.indexOf('--init-state');
    const queueIndex = args.indexOf('--queue');

    try {
        const codeCell = await compileContract(contractPath);

        const options: DebugConsoleOptions = {};

        if (initStateIndex !== -1 && initStateIndex < args.length - 1) {
            const statePath = args[initStateIndex + 1];
            options.initialState = await validateInitState(statePath);
        }

        if (queueIndex !== -1 && queueIndex < args.length - 1) {
            const queuePath = args[queueIndex + 1];
            options.initialQueue = await loadMessageQueue(queuePath);
        }

        const debugConsole = new TONDebugConsole(options, codeCell);
        await debugConsole.initialize();
    } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}

function printHelp(): void {
    console.log(`
TON Debug Console - Interactive debugger for TON smart contracts

Usage:
  tondebug --contract <path> [--init-state <path>] [--queue <path>] [--help]

Options:
  --contract <path>    Path to FunC contract source file
  --init-state <path>  Path to initial state JSON file
  --queue <path>       Path to initial message queue JSON file
  --help               Show this help message

Example:
  tondebug --contract ./my-contract.fc --init-state ./state.json --queue ./messages.json
`);
}

main().catch(console.error);