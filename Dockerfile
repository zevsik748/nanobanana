
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN node -e "const fs=require('fs');let p=JSON.parse(fs.readFileSync('package.json','utf8')); if(p.devDependencies&&p.devDependencies.mastra){ delete p.devDependencies.mastra; fs.writeFileSync('package.json', JSON.stringify(p,null,2)); }"

RUN npm config set legacy-peer-deps true && npm install --no-audit --no-fund

COPY . .

RUN npx mastra build

ENV PORT=8000
EXPOSE 8000

CMD ["node", ".mastra/output/index.mjs"]
