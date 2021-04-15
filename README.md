


#  Setup Linux server to capture files from ip-campera

I need to see the videos, in a browser, fast navigate, and teir to cloud

## Ops

### list services
```
systemctl --type=service
```
### list logs
```
sudo journalctl -u camera1_ffmpeg.service -f
sudo journalctl -u camera1_web.service -f
```
### stop/start/enable
```
sudo systemctl stop  camera1_web.service
```

## Build & Run web

```
# install dependencies
npm i

# build typescript
npm run-script buildserver

# build fromend
REACT_APP_CAMERA_NAME=mycamera npm run-script build

# run
CAMERA_NAME="mycamera" CAMERA_IP="x.x.x.x" CAMERA_PASSWD="xxx" FILEPATH="/video" WEBPATH="/home/xxx/xxx/build" DBPATH="/home/xxx/xxx/mydb" node ./server/out/index.js

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

## Create a shell script to start ffmpeg

create a file called ```ffmpeg_start.sh```

```
CAMERA_NAME="xxx" CAMERA_IP="xxx.xxx.xxx.xxx" CAMERA_PASSWD="xxx" FILEPATH="/video"
export CAMERA_NAME CAMERA_IP CAMERA_PASSWD FILEPATH
mkdir -p ${FILEPATH}/${CAMERA_NAME}

#ffmpeg -rtsp_transport tcp -i rtsp://admin:${CAMERA_PASSWD}@${CAMERA_IP}/h264Preview_01_main \
# -r 25 \
# -hide_banner -loglevel error \
# -vcodec copy \
# -start_number $(echo "$(date +%s) - 1600000000" | bc) \
# ${FILEPATH}/${CAMERA_NAME}/stream.m3u8

TOKEN=$(curl -X POST -d "[{\"cmd\":\"Login\",\"action\":0,\"param\":{\"User\":{\"userName\":\"admin\",\"password\":\"${CAMERA_PASSWD}\"}}}]" "http://${CAMERA_IP}/cgi-bin/api.cgi?cmd=Login&token=null" \
  | grep \"name\" | sed -E 's/.*"name" : "?([^,"]*)"?.*/\1/')
  
export TOKEN
ffmpeg -i "rtmp://admin:${CAMERA_PASSWD}@${CAMERA_IP}/bcs/channel0_main.bcs?token=${TOKEN}&channel=0&stream=0" \
  -r 25 \
  -hide_banner -loglevel error \
  -vcodec copy \
  -start_number $(echo "$(date +%s) - 1600000000" | bc) \
  ${FILEPATH}/${CAMERA_NAME}/stream.m3u8
```

Copy the ```camera1_ffmpeg.service``` file to ```/etc/systemd/system``` , and replacing the xxxx

run

```
sudo systemctl enable  camera1_ffmpeg.service
```

## Video Format Info

The video encapsulation format used by all Reolink cameras is MP4. So the video's format we download via Reolink Client or Reolink app is MP4. But when using USB disk to backup videos directly from Reolink NVR, you could choose either H.264 or MP4 video files. - the compression type is H264

The Real Time Streaming Protocol (RTSP)

rtsp://server/publishing_point/file
rtsp://username:pwd@IP:port/videoMain

### images snapshot

```
http://(ip address)/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=(any combination of numbers and letters)&user=(user name)&password=(user password)
```

## The player

https://videojs.com/

```
npm install --save @videojs/http-streaming
```


HTTP Live Streaming (HLS) is a widely used protocol developed by Apple that will serve your stream better to a multitude of devices. HLS will take your stream, break it into chunks, and serve it via a specialized playlist

ffmpeg -rtsp_transport tcp -i rtsp://user:passws@<IP>:554/h264Preview_01_main -f hls ./static/video/hls/hls_preview_01_main


## Awesome

Motion detection

```
curl "http://xxxxxxxx/api.cgi?cmd=GetMdState&user=admin&password=xxxxx"
```
 1 = motion
 0 = no motion
```
[
   {
      "cmd" : "GetMdState",
      "code" : 0,
      "value" : {
         "state" : 1
      }
   }
]
```
