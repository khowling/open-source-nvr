
# Object Detection App

This app can be lauched by the server to analyse objects from the images the cameras are streaming


## Build



python3 -m venv venv
source venv/bin/activate

python3 -m pip install -r requirements.txt

echo "/video/front/image150616464.jpg" | python3 detect.py --model_path ./model/yolo11.rknn --target rk3588
