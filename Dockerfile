FROM node:18-alpine

# Install PowerShell Core (pwsh) dependencies for Alpine/musl
RUN apk add --no-cache \
    ca-certificates \
    less \
    ncurses-terminfo-base \
    krb5-libs \
    libgcc \
    libintl \
    libssl3 \
    libstdc++ \
    tzdata \
    userspace-rcu \
    zlib \
    icu-libs \
    curl

# Download and install PowerShell 7 for Alpine (musl-x64)
RUN curl -L https://github.com/PowerShell/PowerShell/releases/download/v7.4.6/powershell-7.4.6-linux-musl-x64.tar.gz \
      -o /tmp/powershell.tar.gz \
    && mkdir -p /opt/microsoft/powershell/7 \
    && tar zxf /tmp/powershell.tar.gz -C /opt/microsoft/powershell/7 \
    && chmod +x /opt/microsoft/powershell/7/pwsh \
    && ln -s /opt/microsoft/powershell/7/pwsh /usr/bin/pwsh \
    && rm /tmp/powershell.tar.gz

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY .env.example /app/.env

COPY . .

RUN npm run build

EXPOSE 5000

CMD ["npm", "start"]
