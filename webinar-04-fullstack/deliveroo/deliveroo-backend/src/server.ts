import express, { Request, Response } from 'express';
import cors from 'cors';
import { invokeMemoryLeak } from './memory-leak';
import { assertEnvVars } from './env';
import pool from './database';
import redisClient from './redis';
import { getAllEmployees, getAllVehiclesWithDriver, createEmployee } from './queries';
import { mapVehicleRowsToDTOs } from './vehicle.model';
import { mapEmployeeRowToDTO, EmployeeDTO, EmployeeRole } from './employee.model';
import logger from './logger';

const app = express();
const port = process.env.NODE_APP_PORT;

assertEnvVars(
  'NODE_APP_PORT',
  'NODE_ENV',
  'SERVICE_NAME',
  'LOKI_HOST',
  'SIMULATE_MEMORY_LEAK',
  'FRONTEND_URL',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD_FILE',
  'DB_NAME',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD_FILE'
);

// CORS configuration based on environment
const corsOptions = {
  origin: process.env.NODE_ENV === 'production'
    ? process.env.FRONTEND_URL
    : 'http://localhost:4200',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
app.use(cors(corsOptions));
app.use(express.json()); // Enable JSON body parsing

// GET /vehicles endpoint
app.get('/vehicles', async (req: Request, res: Response): Promise<void> => {
  invokeMemoryLeak();
  try {
    // Try to get vehicles from Redis cache
    const cachedVehicles = await redisClient.get('vehicles');
    if (cachedVehicles) {
      logger.info('Returning vehicles from cache');
      // Assume cached vehicles are already in VehicleDTO structure
      res.json(JSON.parse(cachedVehicles));
      return;
    }
    // If not in cache, get from PostgreSQL
    const vehiclesRaw = await getAllVehiclesWithDriver();
    // Map DB fields to VehicleDTO using the model function
    const vehicles = mapVehicleRowsToDTOs(vehiclesRaw);
    // Store mapped VehicleDTOs in Redis cache with expiration of 60 seconds
    await redisClient.set('vehicles', JSON.stringify(vehicles), { EX: 60 });
    res.json(vehicles);
  } catch (err) {
    logger.error('Error fetching vehicles:', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /employees endpoint
app.get('/employees', async (req: Request, res: Response): Promise<void> => {
  invokeMemoryLeak();
  try {
    // Try to get employees from Redis cache
    const cachedEmployees = await redisClient.get('employees');
    if (cachedEmployees) {
      logger.info('Returning employees from cache!');
      res.json(JSON.parse(cachedEmployees));
      return;
    }
    // If not in cache, get from PostgreSQL
    const employeesRaw = await getAllEmployees();
    // Map to DTO with camelCase
    const employees = employeesRaw.map(mapEmployeeRowToDTO);
    // Store in Redis cache with expiration of 60 seconds
    await redisClient.set('employees', JSON.stringify(employees), { EX: 60 });
    res.json(employees);
  } catch (err) {
    logger.error('Error fetching employees:', { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

interface EmployeeRequestBody {
  employeeId?: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  phoneNumber?: string;
  email: string;
  role: string;
  licenseNumber?: string;
  licenseExpiration?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
}

// POST /employees endpoint to add a new employee
app.post('/employees', async (req: Request, res: Response): Promise<void> => {
  invokeMemoryLeak();
  try {
    const employeeData: EmployeeRequestBody = req.body;

    // Validate required fields
    if (!employeeData.firstName || !employeeData.lastName || !employeeData.email || !employeeData.role) {
      logger.error('Missing required fields in employee creation request');
      res.status(400).json({ error: 'Missing required fields: firstName, lastName, email, role' });
      return;
    }

    // Validate role against allowed enum values
    const validRoles = ['driver', 'dispatcher', 'manager'];
    if (!validRoles.includes(employeeData.role.toLowerCase())) {
      logger.error(`Invalid role provided: ${employeeData.role}. Must be one of: ${validRoles.join(', ')}`);
      res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
      return;
    }

    const newEmployee = await createEmployee(employeeData);
    const mappedEmployee = mapEmployeeRowToDTO(newEmployee);
    
    logger.info('New employee added to DB:', mappedEmployee);
    
    // Invalidate the employees cache
    await redisClient.del('employees');
    logger.info('Invalidated employees cache');
    
    res.status(201).json({ message: 'Employee added successfully', employee: mappedEmployee });
  } catch (err) {
    logger.error('Error adding employee: ' + err, { err });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/', (req: Request, res: Response): void => {
  res.json({ status: 'Deliveroo backend is running!', timestamp: new Date() });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await redisClient.quit();
  await pool.end();
  process.exit(0);
});

app.listen(port, () => {
  logger.info(`Backend listening at http://localhost:${port}`);
}); 