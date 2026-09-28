# Publish UniPath Python on Oracle Cloud Always Free

This version runs as a Python container with a persistent SQLite data volume. Oracle Always Free compute is subject to home-region eligibility, capacity and Oracle’s published reclaim policy. Review the current [Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) before creating resources.

## 1. Create the VM and networking

In OCI, launch an Ubuntu ARM64 VM using `VM.Standard.A1.Flex` marked **Always Free Eligible** in your tenancy’s home region. Keep the free tenancy within the current A1 limits (equivalent to 2 OCPUs and 12 GB memory). Assign a public IPv4 address and add your SSH public key. If the region reports out of capacity, retry later or use a different availability domain in the same home region.

In the VCN security list or network security group, permit inbound TCP 80 and 443 from the internet. Limit TCP 22 to your own IP address. Allow the same web ports in the VM firewall if enabled.

## 2. Use a free hostname

Create a free subdomain at [DuckDNS](https://www.duckdns.org/) and point its A record at the VM public IP. Caddy will use that public hostname for HTTPS. If the VM IP changes, update the DNS record. A public DNS name must resolve to the VM, and ports 80/443 must reach Caddy for automatic certificate provisioning.

## 3. Copy and build the Python project

From Windows PowerShell, copy the folder to the VM:

```powershell
scp -r "C:\Users\YOUR_NAME\Desktop\UniPath-Python" ubuntu@YOUR_VM_IP:~/unipath
```

SSH into the VM and install Docker:

```bash
sudo apt-get update
sudo apt-get install -y docker.io
sudo systemctl enable --now docker
cd ~/unipath
sudo docker build -t unipath-python:latest .
sudo docker network create unipath-web
sudo mkdir -p /opt/unipath/data /opt/unipath/caddy
```

Create Caddy’s config (replace the hostname with your DuckDNS name):

```bash
sudo tee /opt/unipath/caddy/Caddyfile >/dev/null <<'EOF'
YOUR_NAME.duckdns.org {
    reverse_proxy unipath-python:8080
}
EOF
```

Generate unique values for both secrets. Keep them private and do not commit them to the project:

```bash
openssl rand -hex 32
```

Start the app. Replace the two placeholders with different random values and use the same hostname as the Caddyfile:

```bash
sudo docker run -d --name unipath-python --restart unless-stopped \
  --network unipath-web \
  -v /opt/unipath/data:/app/data \
  -e ADMIN_PASSWORD='YOUR_UNIQUE_ADMIN_PASSWORD' \
  -e APP_SECRET_KEY='YOUR_LONG_RANDOM_SESSION_SECRET' \
  -e COOKIE_SECURE=true \
  -e PUBLIC_URL='https://YOUR_NAME.duckdns.org' \
  unipath-python:latest
```

Start Caddy:

```bash
sudo docker run -d --name unipath-caddy --restart unless-stopped \
  --network unipath-web \
  -p 80:80 -p 443:443 -p 443:443/udp \
  -v /opt/unipath/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v /opt/unipath/caddy/data:/data \
  -v /opt/unipath/caddy/config:/config \
  caddy:2
```

Once DNS has propagated and the certificate is issued, visit `https://YOUR_NAME.duckdns.org`. Caddy provisions and renews HTTPS certificates automatically when DNS and ports are configured correctly. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)

## 4. Keep app data and secrets safe

The persistent SQLite database is mounted at `/opt/unipath/data`; back up that folder regularly. Configure SMTP if you want password reset emails, and set `GOOGLE_CLIENT_ID` if you enable Google sign-in. Add the deployed HTTPS origin to Google’s authorized JavaScript origins.

For updates, copy the new source, rebuild the image, remove/recreate only the app container with the same environment settings and keep `/opt/unipath/data`. Never publish the demo admin password or session secret.
