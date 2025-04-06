import { Cell, Address, toNano, beginCell, SendMode } from "@ton/core";
import { hex } from "../build/main.compiled.json";
import { Blockchain, BlockchainTransaction, internal, PendingMessage, createShardAccount} from "@ton/sandbox";
import { MainContract } from "../wrappers/MainContract";
import {randomAddress} from "@ton/test-utils";

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
    });
  
  });

