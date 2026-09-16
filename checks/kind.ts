export interface Finding {
  check: string
  path: string
  line: number
  message: string
}

export interface Check {
  name: string
  run: (root: string) => Promise<Finding[]>
}
