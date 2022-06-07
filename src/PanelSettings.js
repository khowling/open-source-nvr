import React  from 'react';
import {  Text, DefaultButton, Dropdown, Stack, TextField, Slider, TagPicker, Separator, Label, MessageBar, MessageBarType, Checkbox, PrimaryButton, Panel } from '@fluentui/react'


const cocoNames= [
    "person",
    "bicycle",
    "car",
    "motorbike",
    "aeroplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "sofa",
    "pottedplant",
    "bed",
    "diningtable",
    "toilet",
    "tvmonitor",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush"
    ].map(item => ({ key: item, name: item }));



export function PanelSettings({panel, setPanel, data, getServerData}) {

    const [error, setError] = React.useState(null)

    function updatePanelValues(field, value) {
        var calcFolder = panel.values.folder || ''
        if (field === "name") {
          if (!calcFolder) {
            calcFolder = value
          } else if (calcFolder.includes(panel.values.name)) {
            calcFolder = calcFolder.replace(panel.values.name, value)
          }
        }
    
    
        setPanel({...panel, values: {...panel.values, 
          [field]: value, 
          ...(field === "enable_streaming" && value === false && {enable_movement: false}),
          ...(field !== 'folder' && panel.key !== 'settings' && {folder: calcFolder})
        }})
    }

    function getError(field) {
        const idx = panel.invalidArray.findIndex(e => e.field === field)
        return idx >= 0 ? panel.invalidArray[idx].message : ''
    }

    function invalidFn(field, invalid, message) {
        const e = panel.invalidArray.find(e => e.field === field)
        if (!invalid && e) {
          setPanel((prev) => {return {...prev, invalidArray: prev.invalidArray.filter((e) => e.field !== field)}})
        } else if (invalid && !e) {
          setPanel((prev) => {return {...prev, invalidArray: prev.invalidArray.concat({ field, message })}})
        }
      }
    
      if (panel.open) {
    
        if (panel.key === 'settings') {
          invalidFn('disk_base_dir', !panel.values.disk_base_dir || panel.values.disk_base_dir.endsWith('/') || !panel.values.disk_base_dir.startsWith('/'),
            <Text>Must be abosolute path (cannot end with '/')</Text>)
          invalidFn('darknetDir', panel.values.enable_ml && (!panel.values.darknetDir || panel.values.darknetDir.endsWith('/') || !panel.values.darknetDir.startsWith('/')),
            <Text>Must be abosolute path (cannot end with '/')</Text>)
        } else {
          invalidFn('name', !panel.values.name || panel.values.name.match(/^[a-z0-9][_\-a-z0-9]+[a-z0-9]$/i) === null || panel.values.name.length > 19,
            <Text>Enter valid camera name</Text>)
    
          invalidFn('disk', !panel.values.disk ,
            <Text>Require a Disk to store the files on, goto General Settings to create</Text>)
    
          invalidFn('folder', !panel.values.folder || panel.values.folder.startsWith('/') || panel.values.folder.endsWith('/'),
            <Text>Require a folder to store the files for this camera (relitive to disk, don't start with '/')</Text>)
    
            if (panel.key === "new") {
            invalidFn('ip', !panel.values.ip || panel.values.ip.match(/^([0-9]{1,3}\.){3}[0-9]{1,3}$/i) === null,
              <Text>Enter valid camera IPv4 address</Text>)
          } else {
            invalidFn('ip', panel.values.ip && panel.values.ip.match(/^([0-9]{1,3}\.){3}[0-9]{1,3}$/i) === null,
              <Text>Enter valid camera IPv4 address</Text>)
          }
        }
    }



    const listContainsTagList = (tag, tagList) => {
      if (!tagList || !tagList.length || tagList.length === 0) {
        return false;
      }
      return tagList.some(compareTag => compareTag.key === tag.key);
    }

    function savePanel(event, ctx) {
        const {key} =  ctx && typeof ctx === 'object' ? ctx : {}

        setError(null)
        fetch(`/api/${panel.key === 'settings' ? 'settings' : `camera/${panel.values.key || 'new'}`}${key && panel.values.key ? `?delopt=${key}` : ''}`, {
        method: 'POST',
        credentials: 'same-origin',
        mode: 'cors',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(panel.values)
        }).then(res => {
        if (res.ok) {
            console.log(`created success : ${JSON.stringify(res)}`)
            getServerData()
            setPanel({open: false, invalidArray: []})
        } else {
            return res.text().then(text => {throw new Error(text)})
            //const ferr = `created failed : ${succ.status} ${succ.statusText}`
            //console.error(ferr)
            //setError(ferr)
        }
        
        }).catch(error => {
        console.error(`created failed : ${error}`)
        setError(`created failed : ${error}`)
        })
    }

    const currCamera = panel.key === 'edit' && data.cameras && panel.values.key && data.cameras.find(c => c.key === panel.values.key)


    return (

        <Panel
            headerText={panel.heading}
            isOpen={panel.open}
            onDismiss={() => setPanel({...panel, open: false, invalidArray: []})}
            // You MUST provide this prop! Otherwise screen readers will just say "button" with no label.
            closeButtonAriaLabel="Close">

          { panel.open && 
            <Stack>
                { panel.key === 'settings' ? 
                <>

                    <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Storage Settings</b></Separator>
                    <TextField label="Disk Mount Folder" iconProps={{ iconName: 'Folder' }}  required value={panel.values.disk_base_dir} onChange={(ev, val) => updatePanelValues('disk_base_dir', val)} errorMessage={getError('disk_base_dir')} />
                    
                    <Checkbox label="Enable Disk Cleanup" checked={panel.values.enable_cleanup} onChange={(ev, val) => updatePanelValues('enable_cleanup', val)} styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}/>
                    <Slider disabled={!panel.values.enable_cleanup} label="Keep under Capacity %" min={1} max={99} step={1} defaultValue={panel.values.cleanup_capacity} showValue onChange={(val) => updatePanelValues('cleanup_capacity', val)} />
                    <Slider disabled={!panel.values.enable_cleanup} label="Check Capacity Interval (minutes)" min={1} max={60} step={1} defaultValue={panel.values.cleanup_interval} showValue onChange={(val) => updatePanelValues('cleanup_interval', val)} />


                    <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Object Detection (using <a target="_other" href="https://pjreddie.com/darknet/yolo/">yolo</a>)</b></Separator>
                    
                    <Checkbox label="Enable Object Detection" checked={panel.values.enable_ml} onChange={(ev, val) => updatePanelValues('enable_ml', val)} styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}/>
                    
                    <TextField disabled={!panel.values.enable_ml} label="DarkNet and Yolo install folder " iconProps={{ iconName: 'Folder' }}  required value={panel.values.darknetDir} onChange={(ev, val) => updatePanelValues('darknetDir', val)} errorMessage={getError('darknetDir')} />
                    
                    { data.config && data.config.status  &&  Object.keys(data.config.status).length > 0 && 
                    <Stack.Item>
                        <Separator/>
                        <MessageBar>{JSON.stringify(data.config.status, null, 2)}</MessageBar>
                    </Stack.Item>
                    }

                </>
                :
                <>
                    <Label>Camera ID: {panel.values.key}</Label>
                    <TextField label="Camera Name" onChange={(ev, val) => updatePanelValues('name', val)} required errorMessage={getError('name')} value={panel.values.name} />
                    <TextField label="IP Address" prefix="IP" onChange={(ev, val) => updatePanelValues('ip', val)} required errorMessage={getError('ip')} value={panel.values.ip} />
                    <TextField label="admin Password" type="password"  value={panel.values.passwd} onChange={(ev, val) => updatePanelValues('passwd', val)} />
                    
                    <Stack horizontal tokens={{ childrenGap: 10 }}>
                    <Dropdown label="Disk" selectedKey={panel.values.disk} options={data.config && [ { key: data.config.settings.disk_base_dir, text: data.config.settings.disk_base_dir}]} required onChange={(ev, {key}) => updatePanelValues('disk', key)} errorMessage={getError('disk')} />
                    <TextField label="Steaming Folder" iconProps={{ iconName: 'Folder' }}  required value={panel.values.folder} onChange={(ev, val) => updatePanelValues('folder', val)} errorMessage={getError('folder')} />
                    </Stack>

                    <Label>Filter Tags (Requires Object Detection)</Label>
                    <TagPicker
                    disabled={data.config && !data.config.settings.enable_ml}
                    onChange={(i) => panel.values.ignore_tags = i.map(i => i.key)}
                    defaultSelectedItems={panel.values.ignore_tags ? panel.values.ignore_tags.map(i => {return {key:i,name:i}} ) : []}
                    removeButtonAriaLabel="Remove"
                    selectionAriaLabel="Selected colors"
                    onResolveSuggestions={(filterText, tagList) => {
                        return filterText
                        ? cocoNames.filter(
                            tag => tag.name.toLowerCase().indexOf(filterText.toLowerCase()) === 0 && !listContainsTagList(tag, tagList),
                            )
                        : [];
                    }}
                    getTextFromItem={(i) => i.name}
                    pickerSuggestionsProps={{
                        suggestionsHeaderText: 'Suggested tags',
                        noResultsFoundText: 'No tags found',
                    }}
                    />

                    <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Playback</b></Separator>
                    <Checkbox label="Enable Streaming" checked={panel.values.enable_streaming} onChange={(ev, val) => { updatePanelValues('enable_streaming', val)} } />

                    { currCamera && currCamera.ffmpeg_process &&
                    <Stack.Item>
                        <Separator/>
                        <MessageBar messageBarType={currCamera.ffmpeg_process.error ? MessageBarType.error : (currCamera.ffmpeg_process.running ?  MessageBarType.success : MessageBarType.warning)}>{JSON.stringify(currCamera.ffmpeg_process, null, 2)}</MessageBar>
                    </Stack.Item>
                    }

                    <Stack styles={{ root: { marginTop: "15px !important"} }}>
                    <Slider disabled={!panel.values.enable_streaming} label="Segments(2s) prior to movement" min={0} max={60} step={1} defaultValue={panel.values.segments_prior_to_movement} showValue onChange={(val) => updatePanelValues('segments_prior_to_movement', val)} />
                    <Slider disabled={!panel.values.enable_streaming} label="Segments(2s) post movement" min={0} max={60} step={1} defaultValue={panel.values.segments_post_movement} showValue onChange={(val) => updatePanelValues('segments_post_movement', val)} />
                    </Stack>

                    <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Movement processing</b></Separator>
                    
                    <Checkbox disabled={!panel.values.enable_streaming} label="Enable Movement" checked={panel.values.enable_movement} onChange={(ev, val) => updatePanelValues('enable_movement', val)} />
                    
                    { currCamera && currCamera.movementStatus &&
                    <Stack.Item>
                        <Separator/>
                        <MessageBar messageBarType={currCamera.movementStatus.fail ? MessageBarType.error : (currCamera.movementStatus.current_movement ?  MessageBarType.success : MessageBarType.warning)}>{JSON.stringify(currCamera.movementStatus, null, 2)}</MessageBar>
                    </Stack.Item>
                    }

                    <Stack styles={{ root: { marginTop: "15px !important"} }}>
                    <Slider disabled={!panel.values.enable_movement} label="Poll Frequency (mS)" min={1000} max={10000} step={500} defaultValue={panel.values.mSPollFrequency} showValue onChange={(val) => updatePanelValues('mSPollFrequency', val)} />
                    <Slider disabled={!panel.values.enable_movement} label="Seconds without movement" min={0} max={50} step={1} defaultValue={panel.values.secWithoutMovement} showValue onChange={(val) => updatePanelValues('secWithoutMovement', val)} />
                    {panel.key}
                    </Stack>


                    { panel.key === 'edit' &&
                    <Stack styles={{ root: { marginTop: "15px !important"} }}>
                        <DefaultButton  text="Delete" disabled={panel.invalidArray.length >0} split menuProps={{ items: [
                        {
                            key: 'del',
                            text: 'Delete Camera',
                            iconProps: { iconName: 'Delete' },
                            onClick: savePanel
                        },
                        {
                            key: 'delall',
                            text: 'Delete Camera & Recordings',
                            iconProps: { iconName: 'Delete' },
                            onClick: savePanel
                        }]}} />
                        </Stack>
                    }

                </>
            }

                <PrimaryButton styles={{ root: { marginTop: "15px !important"}}} disabled={panel.invalidArray.length >0} text="Save" onClick={savePanel}/>

                {error &&
                <MessageBar messageBarType={MessageBarType.error} isMultiline={false} truncated={true}>
                {error}
                </MessageBar>
            }
            </Stack>
        }
      </Panel>
    )
}