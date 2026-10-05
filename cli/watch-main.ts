import { join } from 'node:path'
import { migrate, open } from '../store/index.ts'
import { alerter, livenessLine, watch } from './watch.ts'

const root = process.cwd()
const handle = open(join(root, 'cf.db'))
migrate(handle, join(root, 'schema'))
process.stdout.write(livenessLine(handle, watch(handle, root, new Date(), alerter())))
