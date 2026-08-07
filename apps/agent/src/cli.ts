const flagIndex = process.argv.indexOf('--workdir')
const workdir = flagIndex === -1 ? undefined : process.argv[flagIndex + 1]

if (workdir === undefined) {
  console.error('usage: studio-agent --workdir <path>')
  process.exit(1)
}

process.stdout.write(JSON.stringify({ type: 'ready', workdir }) + '\n')
