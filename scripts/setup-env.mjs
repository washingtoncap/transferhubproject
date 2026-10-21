import {readFile,writeFile,access} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
try{await access('.env');console.log('.env already exists; left unchanged');}catch{const template=await readFile('.env.example','utf8');await writeFile('.env',template.replace('replace-with-at-least-32-random-characters',randomBytes(32).toString('hex')),{mode:0o600});console.log('Created .env with a local diagnostic token');}
