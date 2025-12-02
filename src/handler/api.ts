import { DataCache } from "../database/cache";
import { MachineStateTable } from "../database/table";
import { IdentityProviderClient } from "../external/idp";
import { SmartMachineClient } from "../external/smart-machine";
import { GetMachineRequestModel, HttpResponseCode, MachineResponseModel, RequestMachineRequestModel, RequestModel, StartMachineRequestModel } from "./model";
import { MachineStateDocument, MachineStatus } from "../database/schema";
/**
 * Handles API requests for machine operations.
 * This class is responsible for routing requests to the appropriate handlers
 * and managing the overall workflow of machine interactions.
 */
export class ApiHandler {
    private cache: DataCache<MachineStateDocument>;
    constructor() {
        this.cache = DataCache.getInstance<MachineStateDocument>();
    }

    /**
     * Validates an authentication token.
     * @param token The token to validate.
     * @throws An error if the token is invalid.
     */
    private checkToken(token: string) {

        const identityClient = IdentityProviderClient.getInstance();
        const tokenIsValid = identityClient.validateToken(token);

        if (!tokenIsValid) {
        const authErrorPayload = {
            statusCode: HttpResponseCode.UNAUTHORIZED,
            message: "Invalid token"
        };
        throw JSON.stringify(authErrorPayload);
        }
    }

    /**
     * Handles a request to find and reserve an available machine at a specific location.
     * It finds an available machine, updates its status to AWAITING_DROPOFF,
     * assigns the job ID, and caches the updated machine state.
     * NOTE: The current implementation assumes a machine will be held for a certain period,
     * but there is no mechanism to release the hold if the user doesn't proceed.
     * @param request The request model containing location and job IDs.
     * @returns A response model with the status code and the reserved machine's state.
     */
    private handleRequestMachine(request: RequestMachineRequestModel): MachineResponseModel {
        
        const { locationId, jobId } = request;

        if (!locationId || !jobId) {
            return { statusCode: HttpResponseCode.BAD_REQUEST };
        }

        const table = MachineStateTable.getInstance();

        // Get all machines at this location
        const machinesAtLocation: MachineStateDocument[] =
            table.listMachinesAtLocation(locationId);

        // Find an AVAILABLE machine
        const availableMachine = machinesAtLocation.find(
        (machine) => machine.status === MachineStatus.AVAILABLE
        );

        if (!availableMachine) {
            // No available machine at that location
            return { statusCode: HttpResponseCode.NOT_FOUND };
        }

        const machineId = availableMachine.machineId; 

        // Update DB
        table.updateMachineJobId(machineId, jobId);
        table.updateMachineStatus(machineId, MachineStatus.AWAITING_DROPOFF);

        availableMachine.currentJobId = jobId;
        availableMachine.status = MachineStatus.AWAITING_DROPOFF;

        // Cache updated machine
        this.cache.put(machineId, availableMachine);

        return {
            statusCode: HttpResponseCode.OK,
            machine: availableMachine
        };
    }

    /**
     * Retrieves the state of a specific machine.
     * It first checks the cache for the machine's data and, if not found, fetches it from the database.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the machine's state.
     */
    private handleGetMachine(request: GetMachineRequestModel): MachineResponseModel {
        const { machineId } = request;

        if (!machineId) {
            return { statusCode: HttpResponseCode.BAD_REQUEST };
        }

        const cached = this.cache.get(machineId);
        if (cached) {
            return {
                statusCode: HttpResponseCode.OK,
                machine: cached
            };
        }

        const table = MachineStateTable.getInstance();
        const doc = table.getMachine(machineId); 

        if (!doc) {
            return {
                statusCode: HttpResponseCode.NOT_FOUND
            };
        }

        this.cache.put(machineId, doc);

        return {
            statusCode: HttpResponseCode.OK,
            machine: doc
        };
    }

    /**
     * Starts the cycle of a machine that is awaiting drop-off.
     * It validates the machine's status, calls the external Smart Machine API to start the cycle,
     * and updates the machine's status to RUNNING.
     * @param request The request model containing the machine ID.
     * @returns A response model with the status code and the updated machine's state.
     */
    private handleStartMachine(request: StartMachineRequestModel): MachineResponseModel {
        const { machineId } = request;

        if (!machineId) {
            return { statusCode: HttpResponseCode.BAD_REQUEST };
        }

        const table = MachineStateTable.getInstance();

        let machine = this.cache.get(machineId);

        if (!machine) {
            machine = table.getMachine(machineId);
        }

        if (!machine) {
            return { statusCode: HttpResponseCode.NOT_FOUND };
        }

        // If machine is not awaiting dropoff, return BAD_REQUEST
        if (machine.status !== MachineStatus.AWAITING_DROPOFF) {
            return {
                statusCode: HttpResponseCode.BAD_REQUEST,
                machine
            };
        }

        const smartClient = SmartMachineClient.getInstance();

        try {
            smartClient.startCycle(machineId);
        } catch {
            table.updateMachineStatus(machineId, MachineStatus.ERROR);
            let updatedErrorMachine = table.getMachine(machineId);
            if (!updatedErrorMachine) {
                updatedErrorMachine = { ...machine, status: MachineStatus.ERROR };
            }

            this.cache.put(machineId, updatedErrorMachine);

            return {
                statusCode: HttpResponseCode.HARDWARE_ERROR,
                machine: updatedErrorMachine
            };
        }

        // Mark machine as running
        table.updateMachineStatus(machineId, MachineStatus.RUNNING);
        let updatedRunningMachine = table.getMachine(machineId);
        if (!updatedRunningMachine) {
            updatedRunningMachine = { ...machine, status: MachineStatus.RUNNING };
        }

        this.cache.put(machineId, updatedRunningMachine);

        return {
            statusCode: HttpResponseCode.OK,
            machine: updatedRunningMachine
        };
    }

    /**
     * The main entry point for handling all API requests.
     * It validates the token and routes the request to the appropriate private handler based on the method and path.
     * @param request The incoming request model.
     * @returns A response model from one of the specific handlers, or an error response.
     */
    public handle(request: RequestModel) {
        this.checkToken(request.token);

        if (request.method === 'POST' && request.path === '/machine/request') {
            return this.handleRequestMachine(request as RequestMachineRequestModel);
        }

        const getMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)$/);
        if (request.method === 'GET' && getMachineMatch) {
            const machineId = getMachineMatch[1];
            const getRequest = { ...request, machineId } as GetMachineRequestModel;
            return this.handleGetMachine(getRequest);
        }

        const startMachineMatch = request.path.match(/^\/machine\/([a-zA-Z0-9-]+)\/start$/);
        if (request.method === 'POST' && startMachineMatch) { 
            const machineId = startMachineMatch[1];
            const startRequest = { ...request, machineId } as StartMachineRequestModel;
            return this.handleStartMachine(startRequest);
        }

        return { statusCode: HttpResponseCode.INTERNAL_SERVER_ERROR, machine: null };
    }
    
}