import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

export interface Choice<T> {
  label: string
  hint?: string
  value: T
}

const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const RED = '\x1b[31m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function draw<T>(choices: Choice<T>[], active: number, redraw: boolean): void {
  if (redraw) stdout.write(`\x1b[${choices.length}A`)
  for (const [i, choice] of choices.entries()) {
    const on = i === active
    const hint =
      choice.hint === undefined ? '' : ` ${DIM}${choice.hint}${RESET}`
    stdout.write(
      `\x1b[2K${on ? `${CYAN}› ` : '  '}${choice.label}${on ? RESET : ''}${hint}\n`,
    )
  }
}

export function select<T>(title: string, choices: Choice<T>[]): Promise<T> {
  stdout.write(`${BOLD}${title}${RESET}\n`)
  draw(choices, 0, false)

  return new Promise<T>((done) => {
    let active = 0
    const restore = (): void => {
      stdin.off('data', onKey)
      stdin.setRawMode(false)
      stdin.pause()
    }
    const onKey = (chunk: Buffer): void => {
      const key = chunk.toString()
      if (key === '\x03') {
        restore()
        stdout.write('\n')
        process.exit(130)
      }
      if (key === '\r' || key === '\n') {
        const choice = choices[active]
        if (choice === undefined) return
        restore()
        done(choice.value)
        return
      }
      if (key === '\x1b[A' || key === 'k')
        active = (active - 1 + choices.length) % choices.length
      else if (key === '\x1b[B' || key === 'j')
        active = (active + 1) % choices.length
      else return
      draw(choices, active, true)
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onKey)
  })
}

export async function text(
  title: string,
  validate?: (value: string) => string | undefined,
): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    for (;;) {
      const answer = (await rl.question(`${BOLD}${title}${RESET} `)).trim()
      const problem = validate?.(answer)
      if (problem === undefined) return answer
      stdout.write(`${RED}${problem}${RESET}\n`)
    }
  } finally {
    rl.close()
  }
}
