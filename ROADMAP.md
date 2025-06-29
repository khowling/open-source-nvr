


# Roadmap


| Priority | Epic                          | Title        | Description                                         | Effort |
|----------|------------------------------|--------------|-----------------------------------------------------|--------|
| MED      | Improved Object Detection Accuracy | Improve YOLO | Use higher resolution images for detection, and latest YOLO |        |
| MED | Improved Object Detection Accuracy  | More Samples | grab more sample frames during a movement, and output combine tags | |
| MED | Improved Object Detection Accuracy | Offer Tuning |  allow use of priority, time of day to refine tags, maybe allow movement event to be acceped or rejected and auto calculate filters from that! | |



## Yolo11?

https://docs.ultralytics.com/models/yolo11/

https://docs.ultralytics.com/


https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/README.md


### on a X86 (WSL)

https://github.com/airockchip/rknn_model_zoo

cd rknn_model_zoo/examples/yolo11/model
bash ./download_model.sh



### next step needs the RKNN python module!!

  This is from https://github.com/airockchip/rknn-toolkit2/

cd ../python
python3 -m venv myenv
source myenv/bin/activate

pip3 install rknn-toolkit2
python convert.py ../model/yolo11n.onnx rk3588

### Back on Rock

./build-linux.sh -t rk3588 -a aarch64 -d yolo11

cd install/rk3588_linux_aarch64/rknn_yolo11_demo/model
wget https://ftrg.zbox.filez.com/v2/delivery/data/95f00b0fc900458ba134f8b180b3f7a1/examples/yolo11/yolo11n.onnx


PATH=$PATH:/home/kehowli/cmake-3.31.4-linux-aarch64/bin ./build-linux.sh -t rk3588 -a aarch64 -d yolo11
