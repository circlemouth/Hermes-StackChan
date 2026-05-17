import 'dotenv/config'
import { startServer } from './server.js'
import { startDeviceControlServer } from './device_control.js'

const PORT = Number(process.env.PORT ?? '8765')
const CONTROL_PORT = Number(process.env.STACKCHAN_CONTROL_PORT ?? '8766')
const CONTROL_HOST = process.env.STACKCHAN_CONTROL_HOST ?? '127.0.0.1'

startDeviceControlServer(CONTROL_PORT, CONTROL_HOST)
startServer(PORT)
