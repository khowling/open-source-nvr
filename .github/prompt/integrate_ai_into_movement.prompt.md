---
agent: 'Plan'

model: 'claude-sonnet-4-20250514'
---

Update the server and UI, so if I want to enable object detection, I just need to select the enable box, and select from a dropdown list of yolo11 models, and a relitive path there the frames will be outputted, then ensure the code will start the python app, listening to the correct location for the paths, and it will return to the server, the objects detected including the probability.  this returned data will be stored against the movement, and the highest probability per object will be accumilated in the movement entry in the server, and that will be immediatly viewable in the ui against the movement that is ongoing of completed in the grid.