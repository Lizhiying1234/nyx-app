// 往 CHANGE_LOG「## 流水」后面插一条（正文从文件读，绕开模板字符串里的反引号）
import { readFileSync, writeFileSync } from 'node:fs'
const [file, entryFile] = process.argv.slice(2)
let s = readFileSync(file, 'utf8'); const entry = readFileSync(entryFile, 'utf8').replace(/\r\n/g, '\n')
const head = '## 流水\n'; if (s.split(head).length !== 2) throw new Error('流水 head')
const title = entry.split('\n')[0]; if (s.includes(title)) throw new Error('entry exists')
s = s.replace(head, () => head + '\n' + entry.replace(/\n+$/, '\n')); writeFileSync(file, s, 'utf8'); console.log('inserted:', title.slice(0, 50))
