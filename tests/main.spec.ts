import { Cell, Address, toNano, beginCell, SendMode, ContractState } from "@ton/core";
import { hex } from "../build/main.compiled.json";
import { Blockchain, BlockchainTransaction, internal, PendingMessage, createShardAccount, BlockchainContractProvider} from "@ton/sandbox";
import { MainContract } from "../wrappers/MainContract";
import {randomAddress} from "@ton/test-utils";
import { writeFileSync, readFileSync } from 'fs';

describe("main.fc contract tests", () => {

    it("reverse queue of messages and get method will return first wallet address", async () => {
        const blockchain = await Blockchain.create();
        const codeCell = Cell.fromBoc(Buffer.from(hex, "hex"))[0];
        
        const testContractAddress = randomAddress()

        await blockchain.setShardAccount(testContractAddress, createShardAccount({
            address: testContractAddress,
            code: codeCell,
            data: new Cell(),
            balance: toNano('1'),
        }))

        // const contractProvider = blockchain.provider(address, init);
        // init - initial state of contract
        const provider = blockchain.provider(testContractAddress);

        const senderWallet_1 = await blockchain.treasury("sender_1");
        const senderWallet_2 = await blockchain.treasury("sender_2");
        
        console.log("Contract address:", testContractAddress);
        console.log("Wallet1 address:", senderWallet_1.address);
        console.log("Wallet2 address:", senderWallet_2.address);
        
        const testMsg_1 = internal({
            from: senderWallet_1.address,
            to: testContractAddress,
            value: toNano('0.05'),
            body: beginCell().endCell(),
        });
        
        const testMsg_2 = internal({
            from: senderWallet_2.address,
            to: testContractAddress,
            value: toNano('0.05'),
            body: beginCell().endCell(),
        });

        // sendMessageIter не исполняет сообщения сам по себе, он просто готовит цепочку исполнения и ждет наших команд
        const iter = await blockchain.sendMessageIter(testMsg_1);
        await blockchain.sendMessageIter(testMsg_2);
        
        // способ работы со множеством ожидающих сообщений 
        const messageQueue: PendingMessage[] = (blockchain as any).messageQueue;
        console.log("Pending messages queue:", messageQueue);
        
        // перевернем очередь (потом через скрипты можно как угодно управлять порядком)
        messageQueue.reverse()

        const messageQueueReversed: PendingMessage[] = (blockchain as any).messageQueue;
        console.log("Pending reversed messages queue:", messageQueueReversed);
        
        const stepByStepResults : BlockchainTransaction[] = []

        // здесь поэтапно исполняем транзакции, то есть достаем сообщение из очереди
        // и исполняем его, если в результате исполняемого сообщения создается новое подсообщение,
        // то так же кладем его в очередь (TODO: протестировать на всякий случай этот кейс)
        // итерирование продолжается, пока очередь не опустеет 
        let step = 0;
        for await (const tx of iter) {
            stepByStepResults.push(tx)
            // здесь при исполнении очередной транзакции можем прерывать и возобновлять исполнение
            // break; - можно прекратить исполнение после N транзакций или по какому-то условию
            
            // так можно смотреть какое сообщение исполнилось
            const msg = tx.inMessage;
            console.log("Step", step, "processed message:", msg);
            step++;
            
            // если после первой итерации сделать break, то в очереди останется второе необработанное сообщение 
            // if (step == 1) {
            //     break;
            // }
        }
        
        console.log("Transactions length:", stepByStepResults.length);
       
        const data = await blockchain.runGetMethod(testContractAddress, 'get_the_latest_sender', []);
        const lastSender = data.stackReader.readAddress();
        console.log("Last sender address:", lastSender.toString());

        expect(lastSender.toString()).toBe(senderWallet_1.address.toString());

        const finalState = provider.getState();
        console.log("Contract balance:", (await finalState).balance);
        // дополнительные валюты (например, jettons), которые могут храниться на контракте
        console.log("Extracurrency:", (await finalState).extracurrency);
        console.log("Contract last transaction:", (await finalState).last);
        console.log("Contract state:", (await finalState).state);
    });
    
    it("compare contract states depends on message queue ordering", async () => {
        const blockchain = await Blockchain.create();
        const codeCell = Cell.fromBoc(Buffer.from(hex, "hex"))[0];
        
        const testContractAddress = randomAddress()

        await blockchain.setShardAccount(testContractAddress, createShardAccount({
            address: testContractAddress,
            code: codeCell,
            data: new Cell(),
            balance: toNano('1'),
        }))

        // сохраняем изначальный стейт
        const snapshot = blockchain.snapshot();

        const provider = blockchain.provider(testContractAddress);

        const senderWallet_1 = await blockchain.treasury("sender_1");
        const senderWallet_2 = await blockchain.treasury("sender_2");
        
        console.log("Contract address:", testContractAddress);
        console.log("Wallet1 address:", senderWallet_1.address);
        console.log("Wallet2 address:", senderWallet_2.address);
        
        const testMsg_1 = internal({
            from: senderWallet_1.address,
            to: testContractAddress,
            value: toNano('0.05'),
            body: beginCell().endCell(),
        });
        
        const testMsg_2 = internal({
            from: senderWallet_2.address,
            to: testContractAddress,
            value: toNano('0.05'),
            body: beginCell().endCell(),
        });

        const iter = await blockchain.sendMessageIter(testMsg_1);
        await blockchain.sendMessageIter(testMsg_2);
        
        const messageQueue: PendingMessage[] = (blockchain as any).messageQueue;
        console.log("Pending messages queue:", messageQueue);
        
        messageQueue.reverse()

        const messageQueueReversed: PendingMessage[] = (blockchain as any).messageQueue;
        console.log("Pending reversed messages queue:", messageQueueReversed);
        
        const stepByStepResults : BlockchainTransaction[] = []

        let step = 0;
        for await (const tx of iter) {
            stepByStepResults.push(tx)

            const msg = tx.inMessage;
            console.log("Step", step, "processed message:", msg);
            step++;
        }
        
        console.log("Transactions length:", stepByStepResults.length);
        console.log("Transactions:", stepByStepResults);

        const data = await blockchain.runGetMethod(testContractAddress, 'get_the_latest_sender', []);
        const lastSender = data.stackReader.readAddress();
        console.log("Last sender address:", lastSender.toString());

        expect(lastSender.toString()).toBe(senderWallet_1.address.toString());

        const firstFinalState = provider.getState();
        await saveContractState('states/first_state.json', firstFinalState);

        // загружаем изначальный стейт до отправки и исполнения сообщений
        await blockchain.loadFrom(snapshot);

        const iter2 = await blockchain.sendMessageIter(testMsg_1);
        await blockchain.sendMessageIter(testMsg_2);
        
        // теперь не будем менять порядок сообщений
        const messageQueue2: PendingMessage[] = (blockchain as any).messageQueue;
        console.log("Pending messages queue:", messageQueue2);

        const stepByStepResults2 : BlockchainTransaction[] = []
        step = 0;
        for await (const tx of iter2) {
            stepByStepResults2.push(tx);

            const msg = tx.inMessage;
            console.log("Step", step, "processed message:", msg);
            step++;
        }

        console.log("Transactions length:", stepByStepResults2.length);
        console.log("Transactions:", stepByStepResults2);

        const data2 = await blockchain.runGetMethod(testContractAddress, 'get_the_latest_sender', []);
        const lastSender2 = data2.stackReader.readAddress();
        console.log("Last sender address:", lastSender2.toString());

        // ожидаем теперь, что сохраянили адрес второго кошелька
        expect(lastSender2.toString()).toBe(senderWallet_2.address.toString());

        const secondFinalState = provider.getState();
        await saveContractState('states/second_state.json', secondFinalState);

        compareContractStates('states/first_state.json', 'states/second_state.json');
    });

    it("set initial contract state", async () => {
        const blockchain = await Blockchain.create();

        const stateJson = JSON.parse(readFileSync('states/first_state.json', 'utf-8'));

        // загружаем из файла первоначальное состояние конракта
        const initialState = {
            balance: BigInt(stateJson.balance),
            code: Cell.fromBoc(Buffer.from(stateJson.state.code, 'hex'))[0],
            data: Cell.fromBoc(Buffer.from(stateJson.state.data, 'hex'))[0],
            last: stateJson.last ? {
                lt: BigInt(stateJson.last.lt),
                hash: Buffer.from(stateJson.last.hash, 'hex')
            } : null
        };
        
        const testContractAddress = randomAddress()

        await blockchain.setShardAccount(testContractAddress, createShardAccount({
            address: testContractAddress,
            code: initialState.code,
            data: initialState.data,
            balance: initialState.balance,
        }))

        const data = await blockchain.runGetMethod(testContractAddress, 'get_the_latest_sender', []);
        const lastSender = data.stackReader.readAddress();
        console.log("Last sender address:", lastSender.toString());

        // так как в файле first_state было состояние контракта с переворнутой очередью, то проверяем
        // что у нас сохранен адрес первого кошелька
        expect(lastSender.toString()).toBe('EQDE9IcJ-mJKoVSrVXqtj1Uy3kmogZbeTLrCd9e_LwmAruq6');
    });

    it("test race condition", async () => {
        const bodyB64 = beginCell()
            .storeUint(2, 32)                 
            .endCell();
        console.log(bodyB64.toBoc({ idx: false, crc32: false }).toString("base64"));
        console.log(bodyB64);
    });
  });

async function saveContractState(filename: string, state: Promise<ContractState>) {
    const resolvedState = state instanceof Promise ? await state : state;

    const serializableState = {
        balance: resolvedState.balance.toString(),
        extracurrency: resolvedState.extracurrency ? {
            ...resolvedState.extracurrency,
        } : null,
        last: resolvedState.last ? {
            lt: resolvedState.last.lt.toString(),
            hash: resolvedState.last.hash.toString('hex')
        } : null,
        state: (() => {
            switch (resolvedState.state.type) {
                case 'active':
                    return {
                        type: 'active',
                        code: resolvedState.state.code?.toString('hex') || null, //код контракта
                        data: resolvedState.state.data?.toString('hex') || null //состояние ячейки c4
                    };
                case 'frozen':
                    return {
                        type: 'frozen',
                        stateHash: resolvedState.state.stateHash.toString('hex') //хэш состояния перед заморозкой
                    };
                case 'uninit':
                    return {
                        type: 'uninit'
                    };
            }
        })()
    };

    writeFileSync(filename, JSON.stringify(serializableState, null, 2));
}

function compareContractStates(file1Path: string, file2Path: string) {
    const state1 = JSON.parse(readFileSync(file1Path, 'utf-8'));
    const state2 = JSON.parse(readFileSync(file2Path, 'utf-8'));

    let flag = true;

    if (state1.balance !== state2.balance) {
        console.log(`Balances are different: ${state1.balance} vs ${state2.balance}`);
        flag = false;
    }
    
    if (state1.last?.lt !== state2.last?.lt) {
        console.log(`Last logical transaction times are different: ${state1.last?.lt} vs ${state2.last?.lt}`);
        flag = false;
    }

    if (state1.last?.hash !== state2.last?.hash) {
        console.log(`Last transaction hashes are different: ${state1.last?.hash} vs ${state2.last?.hash}`);
        flag = false;
    }

    if (state1.state.type !== state2.state.type) {
        console.log(`State types are different: ${state1.state.type} vs ${state2.state.type}`);
        flag = false;
    }

    if (state1.state.type === 'active' && state2.state.type === 'active') {
        if (state1.state.code !== state2.state.code) {
            console.log(`Contract codes are different: ${state1.state.code} vs ${state2.state.code}`);
            flag = false;
        }

        if (state1.state.data !== state2.state.data) {
            console.log(`Contract data is different: ${state1.state.data} vs ${state2.state.data}`);
            flag = false;
        }
    }

    if (state1.state.type === 'frozen' && state2.state.type === 'frozen') {
        if (state1.state.stateHash !== state2.state.stateHash) {
            console.log(`State hashes are different: ${state1.state.stateHash} vs ${state2.state.stateHash}`);
            flag = false;
        }
    }

    if (flag === false) {
        console.log("Contract states are different")
    } else {
        console.log("Contract states are not different")
    }
    //TODO:
    //нужно еще добавить сравнение extracurrency
}
