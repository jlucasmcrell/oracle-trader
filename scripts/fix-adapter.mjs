import fs from 'node:fs'

const path = 'src/main/strategies/cryptoConvergence.ts'
let text = fs.readFileSync(path, 'utf8')

text = text.replace('adapter.getAccountInfo()', 'adapter.getAccount()')

fs.writeFileSync(path, text)
console.log('cryptoConvergence.ts adapter method fixed')
