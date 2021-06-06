


#  Use any x86 machine as a Network Video Recorders (NVRs)

This repo contains instructions and an application to monitor your network Security Camera, record the last X hours to your computers harddrive (depending on your harddrive size), and monitor motion events through a webapp.  In addition, using your cameras motion detection to trigger a ML detection process to tag the items in the picture when the camera senses motion.  This was very useful to avoid false positives, like the sun going behind a cloud, or a rain shower.

This repo was developed with a Reolink POE camera, that provided a RTMP endpoint, and a API for motion detection.


## Install / Setup

This is a indepth process, and all pre-requsites may not be fully documented here, but techincal savvy users should be able to get this working.

### Stream your cameras output to your harddrive

The repo contains a file called ```ffmpeg_start.sh``` that will launch a ffmpeg process that streams the video from your cameras rtmp endpoint, and saves the files to your local hardrive partition in [HLS](https://en.wikipedia.org/wiki/HTTP_Live_Streaming) segments. The script takes the following parameters

 * ```-n``` name of camera
 * ```-f``` base directory for the video files
 * ```-i``` IP address of camera
 * ```-p``` Password for camera



Create a ```ffmpeg_front.service``` file for Linux Systemd service managers, to ensure your ffmpeg process starts when the machine starts & will be kept running

```
[Unit]
Description=ffmpeg_front
Wants=network-online.target
After=network-online.target

[Service]
User=xxx
Group=xxx
Type=simple
# If ffmpeg stops, dont try to restart, the crontab runcheck will do it
Restart=no
#Restart=always
#RestartSec=30
#StartLimitBurst=5
ExecStart=/bin/bash /home/xxx/ip-camera-manager/ffmpeg_start.sh -n xxx -f /xxx -i xxx.xxx.0.xxx -p xxx

[Install]
WantedBy=multi-user.target
```

Copy the ```ffmpeg_front.service``` file to ```/etc/systemd/system``` , and replacing the ```xxx```

Enable & run the service

```
sudo systemctl enable  ffmpeg_front.service
sudo systemctl start  ffmpeg_front.service
```

### ffmpeg Wokrarond for camera reboot

If the rtmp stream is interrupted for any reason, maybe by a camera reboot, the ffmpeg process just hangs, it does not terminate, therefore, adding the ```ffmpeg_runcheck.sh``` script to your root crontab will check every minute to see if new video files are being produced, if not, it will restart the ffmeg service. For example

```
* * * * * /bin/bash /home/xxx/ip-camera-manager/ffmpeg_runcheck.sh -n <camera_name> -f /dir
```


### Build & Run Web App

Clone this repo onto a Linux machine, then: 


```
# install dependencies
npm i

# build typescript server
npm run-script buildserver

# build fromend
REACT_APP_CAMERA_NAME=mycamera npm run-script build
```

Create lauch script file called ```web.sh```
```
#!/bin/bash
BACKGROUND="true" CAMERA_NAME="xxx" CAMERA_IP="xxx.xxx.0.xxx" CAMERA_PASSWD="xxx" FILEPATH="/video" WEBPATH="/home/xxx/ip-camera-manager/build" DBPATH="/home/xxx/ip-camera-manager/mydb" node /home/xxx/ip-camera-manager/server/out/index.js

```

Create a ```camera1_web.service``` file for Linux Systemd service managers, to ensure your website starts when the machine starts & will be kept running

```
[Unit]
Description=camera1_web
Wants=network-online.target
After=network-online.target

[Service]
User=xxx
Group=xxx
Type=simple
ExecStart=/home/xxx/ip-camera-manager/web.sh

[Install]
WantedBy=multi-user.target
```

Copy the ```camera1_web.service``` file to ```/etc/systemd/system``` , and replacing the ```xxx```

Enable & run the service

```
sudo systemctl enable  camera1_web.service
sudo systemctl start  camera1_web.service
```

### Implemenet harddrive cleardown

To ensure your harddrive doesnt get filled up, implment the following crontab entry to delete files that is older than a specified number of minutes

```
# Every hour, delete files older than 12hrs (12 * 60mins) = 720
# 18hrs ~= 40GB
0,15,30,45 * * * * find /video -type f  -mmin +720 -exec rm {} \;
```

## Additional Systemd commands

### list services
```
systemctl --type=service
```
### list logs
```
sudo journalctl -u ffmpeg_front.service -f
sudo journalctl -u ffmpeg_front.service -n 100 --no-pager
sudo journalctl -u camera1_web.service -f
```
### stop/start/enable
```
sudo systemctl stop  camera1_web.service
```



## Create Logic Volume for the local files 

To create a logical volume from a volume group storage pool, use the ```lvcreate``` command. Specify the size of the logical volume with the -L option, specify a name with the -n option, and pass in the volume group to allocate the space from.

```
sudo lvcreate -L 40G -n video-files ubuntu-vg
```

format:
```
sudo mkfs -t ext4 /dev/mapper/ubuntu--vg-video--files
```

mount:

```
mkdir /video
sudo mount /dev/mapper/ubuntu--vg-video--files  /video
```

ensure its always mounted:
```
sudo vi /etc/fstab
/dev/mapper/ubuntu--vg-video--files /video ext4 defaults 0 0
```



## Video Format Info

The video encapsulation format used by all Reolink cameras is MP4. So the video's format we download via Reolink Client or Reolink app is MP4. But when using USB disk to backup videos directly from Reolink NVR, you could choose either H.264 or MP4 video files. - the compression type is H264


## The player

https://videojs.com/

```
npm install --save @videojs/http-streaming
```


HTTP Live Streaming (HLS) is a widely used protocol developed by Apple that will serve your stream better to a multitude of devices. HLS will take your stream, break it into chunks, and serve it via a specialized playlist

