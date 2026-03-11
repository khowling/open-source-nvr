# Prometheus Metrics

The NVR server exposes Prometheus metrics at **`GET /metrics`** on the same port as the web UI (default `8080`).

## Available Metrics

### Movement Detection (per camera)
| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `nvr_movement_detection_api_calls_total` | counter | camera, result | Camera motion API poll calls (result: detected/none/error) |
| `nvr_movements_created_total` | counter | camera | New movements detected |
| `nvr_movement_duration_seconds` | histogram | camera | Video duration of finalized movements |

### Object Detection Pipeline (per camera)
| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `nvr_movement_processing_duration_seconds` | histogram | camera | Total time from processing start to completion |
| `nvr_movement_processing_result_total` | counter | camera, result | Processing outcomes (completed/failed/timeout) |
| `nvr_movement_frames_sent_total` | counter | camera | Frames sent to ML detector |
| `nvr_movement_frames_received_total` | counter | camera | ML results received |
| `nvr_ml_frame_processing_duration_seconds` | histogram | camera | Per-frame ML inference latency |
| `nvr_movement_detection_to_processing_lag_seconds` | histogram | camera | Lag between movement detection and ML processing start |
| `nvr_ml_objects_detected_total` | counter | camera, object_class | Objects detected by class (person, car, etc.) |

### ML Detector Health
| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `nvr_ml_detector_running` | gauge | — | 1 if ML detector process is alive |
| `nvr_ml_detector_frames_in_flight` | gauge | — | Frames awaiting ML results |
| `nvr_ml_detector_restarts_total` | counter | reason | Process restarts (scheduled/crash/disabled) |

### Disk Cleanup (per camera)
| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `nvr_disk_cleanup_files_deleted_total` | counter | camera | Video files deleted |
| `nvr_disk_cleanup_bytes_deleted_total` | counter | camera | Bytes reclaimed |
| `nvr_disk_cleanup_movements_deleted_total` | counter | camera | Movement records pruned from DB |
| `nvr_disk_cleanup_runs_total` | counter | — | Cleanup runs executed |

### System
| Metric | Type | Description |
|--------|------|-------------|
| `nvr_control_loop_duration_seconds` | histogram | Control loop iteration time |
| `nvr_active_cameras` | gauge | Cameras with streaming enabled |

Node.js default metrics (GC, event loop, memory, CPU) are also included automatically.

### Key Queries for "Is object detection falling behind?"

```promql
# Lag between movement detection and ML processing start (p95)
histogram_quantile(0.95, rate(nvr_movement_detection_to_processing_lag_seconds_bucket[5m]))

# Frames in flight (sustained high = detector can't keep up)
nvr_ml_detector_frames_in_flight

# Frame drop rate (sent vs received)
rate(nvr_movement_frames_sent_total[5m]) - rate(nvr_movement_frames_received_total[5m])

# Per-frame ML latency (p95)
histogram_quantile(0.95, rate(nvr_ml_frame_processing_duration_seconds_bucket[5m]))
```

---

## Local Prometheus Agent Setup

The recommended setup is a local Prometheus agent that scrapes the NVR `/metrics` endpoint and remote-writes to Azure Monitor managed Prometheus.

### 1. Install Prometheus

```bash
# Download latest Prometheus
wget https://github.com/prometheus/prometheus/releases/download/v2.53.0/prometheus-2.53.0.linux-amd64.tar.gz
tar xvfz prometheus-2.53.0.linux-amd64.tar.gz
sudo mv prometheus-2.53.0.linux-amd64/prometheus /usr/local/bin/
sudo mv prometheus-2.53.0.linux-amd64/promtool /usr/local/bin/
```

### 2. Create Azure Resources

```bash
# Create an Azure Monitor workspace (hosts managed Prometheus)
az monitor account create \
  --name nvr-monitor \
  --resource-group <your-rg> \
  --location <your-location>

# Note the metrics ingestion endpoint from the output, e.g.:
# https://nvr-monitor-xxxx.region.metrics.monitor.azure.com

# Create an Entra ID app registration for authentication
az ad app create --display-name nvr-prometheus-writer
az ad sp create --id <app-id>

# Create a client secret
az ad app credential reset --id <app-id> --append

# Note the appId, password (client secret), and tenant from the output

# Assign "Monitoring Metrics Publisher" role on the Azure Monitor workspace
az role assignment create \
  --assignee <app-id> \
  --role "Monitoring Metrics Publisher" \
  --scope /subscriptions/<sub-id>/resourceGroups/<your-rg>/providers/microsoft.monitor/accounts/nvr-monitor
```

### 3. Configure Prometheus

Create `/etc/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'nvr'
    static_configs:
      - targets: ['localhost:8080']

remote_write:
  - url: 'https://<your-workspace>.metrics.monitor.azure.com/api/v1/write'
    azuread:
      cloud: 'AzurePublic'
      managed_identity:
        client_id: '<app-id>'
      oauth:
        client_id: '<app-id>'
        client_secret: '<client-secret>'
        tenant_id: '<tenant-id>'
```

> **Alternative: Managed Identity** — If running on an Azure VM, use managed identity instead of client secrets. Assign the VM's identity the "Monitoring Metrics Publisher" role and set `managed_identity.client_id` only.

### 4. Run Prometheus as a systemd service

Create `/etc/systemd/system/prometheus.service`:

```ini
[Unit]
Description=Prometheus Agent
After=network.target

[Service]
Type=simple
User=prometheus
ExecStart=/usr/local/bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.retention.time=2h \
  --web.listen-address=:9090 \
  --enable-feature=agent
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --no-create-home --shell /bin/false prometheus
sudo mkdir -p /etc/prometheus /var/lib/prometheus
sudo chown prometheus:prometheus /var/lib/prometheus
sudo systemctl daemon-reload
sudo systemctl enable --now prometheus
```

> The `--enable-feature=agent` flag runs Prometheus in agent mode — it only scrapes and remote-writes, using minimal local storage.

### 5. Verify

```bash
# Check Prometheus is scraping the NVR
curl -s http://localhost:9090/api/v1/targets | jq '.data.activeTargets[].health'

# Check NVR metrics directly
curl -s http://localhost:8080/metrics | head -20
```

### 6. Visualize with Azure Managed Grafana

1. Create an Azure Managed Grafana instance in the Azure portal
2. Link it to your Azure Monitor workspace (done automatically if in the same resource group)
3. The managed Prometheus data source is auto-configured
4. Import dashboards or query metrics using the PromQL examples above
