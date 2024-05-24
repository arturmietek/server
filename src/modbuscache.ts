//
// ModbusCache manages bulk reading of modbus registers.
// requesters register a set of address number and provide a result function
// Modbus checks the buffered results. If all requested data is available, it calls the result function
// Otherwise, it reads the data from modbus
// The requested addresses will be cumulated until a requester calls clearData for a given slave;
import Debug from "debug"
import { Mutex } from 'async-mutex';
import { IModbusData, ImodbusValues, LogLevelEnum, Logger, M2mSpecification, emptyModbusValues } from "specification";
import { Bus, ReadRegisterResultWithDuration } from "./bus";
import { ReadRegisterResult } from "modbus-serial/ModbusRTU";
import { ModbusRegisterType } from "specification.shared";
const minTimeout = 100
const maxTimeouts = 1;
const maxAddressDelta = 10;
const maxRetries = 1;
const debug = Debug("modbuscache");
const debugData = Debug("modbuscache.data");
const debugNext = Debug("modbuscache.next");
const debugTime = Debug("modbuscache.time");
const log = new Logger('modbuscache')
export enum ModbusStates {
    Initial = "Initial",
    RequestLoaded = "RequestLoaded",
    Prepared = "Prepared",
    Connected = "Connected",
    ConnectedFailed = "ConnectedFailed",
    Processing = "Processing",
    ProcessFailed = "ProcessFailed",
    Result = "Result",
    Finished = "Finished"
}

export enum SlaveStates {
    connected = 1,
    disconnected = 0,
    error = -1
}
export interface ImodbusAddress {
    address:number, 
    registerType:ModbusRegisterType,
    length?:number
}

interface IModbusProcess {
    resultTable:Map<number, ReadRegisterResult>, 
    func: (slaveid: number, a: number, length: number) => Promise<ReadRegisterResultWithDuration>
}
// 
// normal state/action flow
// loadAction => RequestLoaded => prepareAddressesAction => connectAction => Connected => 1..n time processAction  => closeAction => Result => processResultAction => Finished => Initial
// Most important exceptions from normal flow:
// loadAction => Result (when there are no addresses or the result is cached)
// connectAction => ConnectFailed => retryConnectAction => connectAction => Connected or failedAction
// processAction => ProcessFailed => retryProcessAction => processAction
// retryProcessAction => connectAction => connectAction => Connected or failedAction
//
export interface IslaveId {
    busid: number;
    slaveid: number;
}
export class ModbusStateMachine {
    private static maxPid: number = 0;
    private static slaveStates = new Map<number, SlaveStates>();
    private state: ModbusStates = ModbusStates.Initial;
    private pid!: number;
    private result = emptyModbusValues();
    private preparedAddresses: ImodbusAddress[] = [];
    private preparedAddressesIndex = 0;
    private retryCount = 0;
    private timeoutCount = 0
    private data: ReadRegisterResult = {
        data: [],
        buffer: Buffer.from("")
    }
    private write: boolean = false
    private retryConnectCount = 0;
    constructor(private task: string, private slaveId: IslaveId, private addresses: Set<ImodbusAddress>, private returnAction: (results: ImodbusValues) => void, private failedAction: (e: any) => void) {
        this.pid = ++ModbusStateMachine.maxPid;
    }
    async next(newState: ModbusStates, action: () => void, actionName?: string) {
        if (action.name != "")
            debugNext("next(" + this.pid + "): " + this.state + "-> " + action.name + "->" + newState);
        else
            if (actionName)
                debugNext("next(" + this.pid + "): " + this.state + "-> " + actionName + "->" + newState);
            else
                debugNext("next(" + this.pid + "): " + this.state + "-> unnamed Action->" + newState);
        this.state = newState;
        if (!action.name.startsWith("bound"))
            action.bind(this)();
        else
            action();
    }
    loadAction() {

        if (this.addresses.size <= 0) {
            debugNext("ModbusCache:submitGetHoldingRegisterRequest no registers to read");
            this.next(ModbusStates.Result, this.processResultAction);
        }
        else
            debugNext("loadAction(" + this.pid + "): reading slaveid: " + this.slaveId.slaveid + " addresses: " + Array.from(this.addresses));

        // The first process will wait for 1ms all others wait for 100ms
        // So, the first process has a chance to fill the results cache.
        // modbusMutex must be released before waiting otherwise the first process can't fill the cache
        this.next(ModbusStates.RequestLoaded, this.prepareAddressesAction)
    }
    prepareWriteAction(startaddress: number, registerType:ModbusRegisterType, data: ReadRegisterResult) {
        this.preparedAddresses.push({ address: startaddress, registerType:registerType ,length: data.data.length })
        this.data = data;
        this.preparedAddressesIndex = 0;
        this.write = true
        this.next(ModbusStates.Prepared, this.connectAction);

    }
    prepareAddressesAction() {
        debugNext("ModbusStateMachine:prepareAddressesAction(" + this.slaveId.slaveid + "): addresses:" + JSON.stringify(Array.from(this.addresses.values()).sort()));

        let previousAddress = { address: -1, registerType: ModbusRegisterType.IllegalFunctionCode};
        let startAddress = { address: -1, registerType: ModbusRegisterType.IllegalFunctionCode};
        let sortedAddresses = Array.from<ImodbusAddress>(this.addresses.values()).sort(function (a, b) {
            let v =  a.registerType - b.registerType;
            if( v)
                return v
            return a.address - b.address
        })
        for (let addr of sortedAddresses) {
            if (previousAddress.address == -1)
                previousAddress = addr;
            if (startAddress.address == -1)
                startAddress = addr;
            if (addr.registerType != previousAddress.registerType || addr.address - previousAddress.address > maxAddressDelta) {
                this.preparedAddresses.push({ address: startAddress.address, length: previousAddress.address - startAddress.address + 1 , registerType: previousAddress.registerType});
                previousAddress = addr
                startAddress = addr
            }
            else
                previousAddress = addr;
        }
        if (startAddress.address >= 0)
            this.preparedAddresses.push({ address: startAddress.address, length: previousAddress.address - startAddress.address + 1 , registerType: previousAddress.registerType});
        debugData("prepareAddressesAction(" + this.slaveId.slaveid + "): " + JSON.stringify(this.preparedAddresses));
        this.preparedAddressesIndex = 0;
        this.next(ModbusStates.Prepared, this.connectAction);
    }
    connectAction() {
        let bus = Bus.getBus(this.slaveId.busid);
        if (bus) {
            bus.connectRTU(this.task).then(() => {
                this.next(ModbusStates.Connected, this.processAction);
                // this.onConnectRTUread(slaveId, addresses, resultFunction)
            }).catch((e) => {
                this.next(ModbusStates.ConnectedFailed, () => { this.retryConnectAction("connectAction", e) }, "(retry)connectAction");
            });
        }
    }
    retryConnectAction(_module: string, e: any) {
        log.log(LogLevelEnum.notice, "Retry Connect: " + (e && e.message ? "module : " + e.message : "") + " " + (e && e.stack ? e.stack : ""));
        if (this.retryConnectCount++ < maxRetries) {
            let bus = Bus.getBus(this.slaveId.busid);
            bus?.reconnectRTU(this.task).then(() => {
                this.next(ModbusStates.Connected, this.processAction);
            }).catch(e => {
                this.next(ModbusStates.ConnectedFailed, () => { this.retryConnectAction("connectAction", e) }, "(retry)connectAction");
            })
        }
        else
            this.next(this.state, () => { this.failedAction(e) }, this.failedAction.name);
    }

    processAction() {
        if (this.preparedAddressesIndex >= this.preparedAddresses.length) {
            this.next(ModbusStates.Result, this.closeAction);
            return;
        }
        let bus = Bus.getBus(this.slaveId.busid);
        if (bus) {
            if (!bus.isRTUopen()) {
                this.next(this.state, this.connectAction);
                return;
            }
            let startAddress = this.preparedAddresses[this.preparedAddressesIndex].address;
            let length = this.preparedAddresses[this.preparedAddressesIndex].length;
            let fc:number = this.preparedAddresses[this.preparedAddressesIndex].registerType
            if (this.write)
                 fc = M2mSpecification.getWriteFunctionCode(this.preparedAddresses[this.preparedAddressesIndex].registerType)
            if (fc == undefined) {
                debugData("processAction:" + "No function code passed: " + fc)
                this.endProcessAction(this.processAction);
                return;
            }

            let start = Date.now()
            let msg = "(" + this.pid + "):processAction: slaveid: " + this.slaveId.slaveid + " startaddr: " + startAddress + " l:" + length + " FC:" + fc
            let tbl = new Map<ModbusRegisterType, IModbusProcess>(
                [
                    [ModbusRegisterType.HoldingRegister, {resultTable:this.result.holdingRegisters, func: bus.readHoldingRegisters}],
                    [ModbusRegisterType.AnalogInputs, {resultTable:this.result.analogInputs, func: bus.readInputRegisters}],
                    [ModbusRegisterType.Coils, {resultTable:this.result.coils, func: bus.readDiscreteInputs}]
                ])
            if(this.write){
                 bus.writeHoldingRegisters(this.slaveId.slaveid, startAddress, this.data).then(() => {
                    this.preparedAddressesIndex++;
                    this.next(ModbusStates.Result, this.closeAction);
                }).catch((e: any) => {
                    this.endProcessAction(this.retryProcessAction.bind(this, "writeRegisters", e), ModbusStates.ProcessFailed, this.retryProcessAction.name);
                })
            }
            else
               if( length)
                    this.processReadFromModbus(startAddress, startAddress, bus!, start, length, msg, tbl.get(fc)!)
        }

    };
    // optimizes the timeout for slaves
    private processReadFromModbus(startAddress: number, readAddress: number, bus: Bus, start: number, length: number, msg: string, read:IModbusProcess) {
        let slave = bus?.getSlaveBySlaveId(this.slaveId.slaveid)
        read.func.bind(bus)(this.slaveId.slaveid, readAddress, length).then((value) => {
            debugTime("read success (" + this.slaveId.slaveid + "," + readAddress + "," + length + ") duration: " + value.duration);
            this.retryCount = 0;
            this.timeoutCount = 0;
            // If this is the longest running read and the timeout is higher, reduce the timeout
            if (slave && slave.modbusTimout && (slave.durationOfLongestModbusCall == undefined || slave.durationOfLongestModbusCall < value.duration)) {
                slave.durationOfLongestModbusCall = value.duration
                debugData(read.func.name + ": set durationOfLongestModbusCall for slaveid: " + slave.slaveid + "to: " + value.duration);
                if (slave.modbusTimout > slave.durationOfLongestModbusCall * 2 && slave.modbusTimout > minTimeout) {
                    slave.modbusTimout = slave.durationOfLongestModbusCall * 2
                    debugData(read.func.name + ": set modbusTimout for slaveid: " + slave.slaveid + "to: " + slave.modbusTimout);
                }
            }
            debugData(read.func.name + ": " + msg + ", data: " + value.data + "buffer: " + JSON.stringify(value.buffer) + " duration: " + value.duration);
            for (let idx = 0; idx < value.data.length; idx++) {
                let buf: Buffer = Buffer.allocUnsafe(2)
                if (value.buffer.length >= idx * 2 + 2)
                    value.buffer.copy(buf, 0, idx * 2, idx * 2 + 2)
                let r: ReadRegisterResult = {
                    data: [value.data[idx]],
                    buffer: buf
                }
                read.resultTable.set(startAddress + idx, r);
            }
            this.preparedAddressesIndex++;
            this.endProcessAction(this.processAction);

            // there are more items to process
        }).catch((e: any) => {
            if (e.duration)
                debugTime("read fail duration: " + e.duration);
            else
                debugTime("read fail Total duration: " + (Date.now() - start));
            //  disable timeout setting
            //  let maxTimeout = bus.getMaxModbusTimeout()
            // increase timeout if timeout occured and current timeout < max timeout for bus
            // if (e.errno == "ETIMEDOUT" && slave && slave.modbusTimout && slave.evalTimeout) {
            //     if (slave.modbusTimout < maxTimeout) {
            //         log.log(LogLevelEnum.notice, read.name + "(" + slave.slaveid + "," + readAddress + ")" + ": Modbus timeout: " + slave.modbusTimout + " retrying with new timeout " + slave.modbusTimout * 2 + "... ")
            //         slave.modbusTimout = slave.modbusTimout * 2
            //         this.processReadFromModbus(startAddress, readAddress, bus, start, length, msg, read)
            //         return
            //     } else if (slave.durationOfLongestModbusCall != undefined) {
            //         // reset timeout, because it's longer than maximu
            //         let timeout = slave.durationOfLongestModbusCall * 2 > maxTimeout ? maxTimeout : slave.durationOfLongestModbusCall * 2
            //         slave.modbusTimout = timeout
            //         log.log(LogLevelEnum.notice, "Reset timeout to " + "(" + slave.slaveid + "," + readAddress + ")" + timeout)
            //     }
            // }
            if (e.errno == "ETIMEDOUT" && this.timeoutCount++ < maxTimeouts) {
                log.log(LogLevelEnum.notice, read.func.name + " TIMEOUT:" + (e.readDetails ? e.readDetails : "") + " retrying ... ")
                this.processReadFromModbus(startAddress, readAddress, bus, start, length, msg, read)
                return;
            }

            debugData(read.func.name + ":" + msg + " failed: " + e.message)
            e.readDetails = " slave: " + this.slaveId.slaveid + " startAddress: " + startAddress + " length: " + length + ""
            this.endProcessAction(this.retryProcessAction.bind(this, read.func.name, e), ModbusStates.ProcessFailed, this.retryProcessAction.name);
        });
    }

    private endProcessAction(action: () => void, state: ModbusStates | undefined = undefined, actionName?: string): void {
        debugNext("endProcessAction")
        if (!state)
            this.next(this.state, action, actionName);
        else
            this.next(state, action, actionName);
    }
    private doClose(e: any) {
        if (e)
            this.next(ModbusStates.ProcessFailed, () => {
                this.failedAction(e)
            }, this.failedAction.name);
        else
            if (this.write)
                this.returnAction(this.result);
            else
                this.next(ModbusStates.Result, this.processResultAction);
    }

    closeAction(e?: any) {
        // close the client
        let bus = Bus.getBus(this.slaveId.busid);
        if (bus) {
            if (bus.isRTUopen()) {
                bus.closeRTU(this.task, this.doClose.bind(this, e))
            }
            else
                this.doClose(e)
        }
    }
    private splitAddresses(module: string, e: any) {
        debug("Split addresses")
        // split request into single parts to avoid invalid address errors as often as possible
        if (this.preparedAddresses[this.preparedAddressesIndex].length! > 1) {
            let startAddress = this.preparedAddresses[this.preparedAddressesIndex].address;
            let registerType = this.preparedAddresses[this.preparedAddressesIndex].registerType
            let length = this.preparedAddresses[this.preparedAddressesIndex].length!;
            this.preparedAddresses[this.preparedAddressesIndex].length = 1;
            for (let l = 1; l < length; l++) {
                this.preparedAddresses.push({ address: startAddress + l, registerType:registerType, length: 1 })
            }
        } else {
            log.log(LogLevelEnum.notice, module + " splitting: " + (e.message ? e.message : "error") + ": (bus: " + this.slaveId.busid + ", slave: " +
                this.slaveId.slaveid + ", address:" + this.preparedAddresses[this.preparedAddressesIndex].address +
                " length: " + this.preparedAddresses[this.preparedAddressesIndex].length + ")")
            this.preparedAddressesIndex++;
        }

    }
    retryProcessAction(module: string, e: any) {
        if (e.stack)
            debug(e.stack)

        if (e.errno == "ETIMEDOUT") {
            let bus = Bus.getBus(this.slaveId.busid);
            let slave = bus?.getSlaveBySlaveId(this.slaveId.slaveid)
            if (slave)
                debug(" Timeout. continue with next data task: " + this.task + " slave: " + this.slaveId.slaveid + " timeout: " + slave.modbusTimout + (e.readDetails ? e.readDetails : ''))
            else
                debug(" Timeout. continue with next data")
            this.preparedAddressesIndex++
            this.next(ModbusStates.Processing, this.processAction);
        }
        else
            if (e.modbusCode) {
                switch (e.modbusCode) {
                    case 2: // Illegal Address
                        debug("retryProcessAction: Illegal Address")
                        // split request into single parts to avoid invalid address errors as often as possible
                        this.splitAddresses(module, e)

                        // Need to reopen the RTU connection, because of it's errourous state after this error    
                        // then continue with next addresses
                        let bus = Bus.getBus(this.slaveId.busid);
                        if (bus)
                            bus.reconnectRTU(this.task).then((_rc) => {
                                this.next(ModbusStates.Processing, this.processAction);
                            }).catch(e => {
                                log.log(LogLevelEnum.error, e.message);
                                if (bus!.isRTUopen())
                                    this.next(ModbusStates.Processing, this.processAction);
                                else
                                    this.next(this.state, () => { this.closeAction(e) }, this.closeAction.name);
                            })
                        break;
                    default:

                        log.log(LogLevelEnum.error, "Modbus Error: " + e.modbusCode)
                        if (e.readDetails)
                            debug("Modbus Error: " + e.modbusCode + " " + e.readDetails)
                        this.next(this.state, () => { this.closeAction(e) }, this.closeAction.name);
                }
            }
            else {
                let readDetails = ""
                if (e.readDetails)
                    readDetails = e.readDetails
                log.log(LogLevelEnum.notice, module + readDetails + ": " + e.message);
                if (this.preparedAddressesIndex < this.preparedAddresses.length)
                    if (this.preparedAddresses[this.preparedAddressesIndex].length! > 1) {
                        this.splitAddresses(module, e)
                        debug(" Error. splitting task: " + this.task + " slave: " + this.slaveId.slaveid + " error: " + e.message + "addresses: " + JSON.stringify(this.preparedAddresses[this.preparedAddressesIndex]))
                        this.next(ModbusStates.Processing, this.processAction);
                    }
                    else if (this.retryCount++ < 2) {
                        debug("Retrying " + readDetails)
                        // Give the device some time to get ready after error
                        setTimeout(() => {
                            this.next(ModbusStates.Processing, this.processAction);
                        }, 20);
                    }

                    else
                        this.next(this.state, () => { this.closeAction(e) }, this.closeAction.name);
                else
                    this.next(this.state, () => { this.closeAction(e) }, this.closeAction.name);
            }
    }

    processResultAction() {
        debugNext("result: slave: " + this.slaveId.busid + "/" + this.slaveId.slaveid + " address/value")
        for (let key of this.result.holdingRegisters.keys()) {
            debug("holdingRegisters(" + this.pid + "): (" + key + "/" + JSON.stringify(this.result.holdingRegisters.get(key)!.data) + ")");
        }
        for (let key of this.result.analogInputs.keys()) {
            debug("analogInputs(" + this.pid + "): (" + key + "/" + JSON.stringify(this.result.analogInputs.get(key)!.data) + ")");
        }
        for (let key of this.result.coils.keys()) {
            debug("analogInputs(" + this.pid + "): (" + key + "/" + JSON.stringify(this.result.coils.get(key)!.data) + ")");
        }
        this.returnAction(this.result);
    }

    static getStatus(slaveId: number): SlaveStates {
        if (ModbusStateMachine.slaveStates.get(slaveId))
            return ModbusStateMachine.slaveStates.get(slaveId)!;
        else
            return SlaveStates.disconnected;
    }
}

export class ModbusCache {
    static readMutex = new Mutex()
    constructor(private task: string) { }
    //static resultMutex:Mutex
    writeRegisters(slaveId: IslaveId, startaddress: number,registerType:ModbusRegisterType,  data: ReadRegisterResult,
        resultFunction: (result: ImodbusValues) => void, failedFunction: (e: any) => void) {
        new ModbusStateMachine("write", slaveId, new Set<ImodbusAddress>(), resultFunction, failedFunction).prepareWriteAction(startaddress,registerType, data);
    }
    submitGetHoldingRegisterRequest(
        slaveId: IslaveId, 
        addresses: Set<ImodbusAddress>, 
        resultFunction: (result: ImodbusValues) => void, failedFunction: (e: any) => void) {
        debug('submitGetHoldingRegisterRequest bus:' + slaveId.busid + "slave: " + slaveId.slaveid)
        if (slaveId.slaveid == -1) {
            failedFunction(new Error("no slaveId passed to submitGetHoldingRegisterRequest"))
        }
        else {

            new ModbusStateMachine(this.task, slaveId, addresses, resultFunction, failedFunction).loadAction();
        }
    }
    static getStatus(slaveId: number): SlaveStates {
        return ModbusStateMachine.getStatus(slaveId);
    }
}


export const exportedForTesting = {
    ModbusStateMachine
}
