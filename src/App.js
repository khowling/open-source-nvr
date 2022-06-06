//import logo from './logo.svg';
import './App.css';
import React  from 'react';
import videojs from 'video.js'
import { ThemeProvider, CommandBar, Text, DefaultButton, Dropdown, DetailsList, SelectionMode, Stack, TextField, Slider, TagPicker, Separator, Label, MessageBar, MessageBarType, Checkbox, Selection, PrimaryButton, Panel } from '@fluentui/react'
import { initializeIcons } from '@fluentui/react/lib/Icons';
import { createTheme } from '@fluentui/react';

const appTheme = createTheme({
  defaultFontStyle: { fontWeight: 'regular' },
  fonts: {
    small: {
      fontSize: '14px',
    },
    medium: {
      fontSize: '16px',
    },
    large: {
      fontSize: '16px',
      fontWeight: 'semibold',
    },
    xLarge: {
      fontSize: '18px',
      fontWeight: 'semibold',
    },
  },
});

initializeIcons(/* optional base url */);

function VideoJS (props)  {

  const videoRef = React.useRef(null);
  const playerRef = React.useRef(null);
  const { options, onReady } = props;

  React.useEffect(() => {
    // make sure Video.js player is only initialized once
    if (!playerRef.current) {
      const videoElement = videoRef.current;
      if (!videoElement) return;

      const player = playerRef.current = videojs(videoElement, options, () => {
        console.log("player is ready");
        onReady && onReady(player);
      });
    } else {
      // you can update player here [update player through props]
      // const player = playerRef.current;
      // player.autoplay(options.autoplay);
      // player.src(options.sources);
    }
  }, [options, videoRef]);

  // Dispose the Video.js player when the functional component unmounts
  React.useEffect(() => {
    const player = playerRef.current;

    return () => {
      if (player) {
        player.dispose();
        playerRef.current = null;
      }
    };
  }, [playerRef]);

  return (
    <div data-vjs-player>
      <video ref={videoRef} className="video-js vjs-big-play-centered" />
    </div>
  );
}


function App() {

  const [panel, setPanel] = React.useState({open: false, invalidArray: []});
  const [error, setError] = React.useState(null)
  //const [invalidArray, setInvalidArray] = React.useState([])

  const init_data = { cameras: [], movements: [] }
  const [data, setData] = React.useState(init_data)
  const [currentPlaying, setCurrentPlaying] = React.useState(null)
  //const [inputState, setInputState] = React.useState({ current_idx: 'none', allSelected: false, inputs: {} })
  const [taggedOnly, setTaggedOnly] = React.useState(true)
  const [showPlayer, setShowPlayer] = React.useState(true)
  //const [playerReady, setPlayerReady] = React.useState(false)


  
  const playerRef = React.useRef(null);
  
  const handlePlayerReady = (player) => {
    playerRef.current = player;

    // you can handle player events here
    player.on('waiting', () => {
      console.log('handlePlayerReady: player is waiting');
    });

    player.on('dispose', () => {
      console.log('handlePlayerReady: player will dispose');
    });
  };

  function getServerData() {
    //setCurrentPlaying(null)
    setData({...init_data, status: 'fetching'})
    fetch(`/api/movements`)
      .then(res => res.json())
      .then(
        (result) => {
          setData({...result, status: 'success'})
          if (!result?.config?.settings?.enable_ml) setTaggedOnly(false)
          console.log (`got refresh, find first streaming enabled camera & play`)
          const streamingCameras = result?.cameras.filter(c => c.enable_streaming)

          if (currentPlaying && streamingCameras.findIndex(c => c.key === currentPlaying.cKey) >= 0 && (!currentPlaying.mKey || result?.movements.findIndex(m => m.key === currentPlaying.mKey) >= 0)) {
            console.log (`we can continue playing same before refresh, because camera and/or movement is still valid`)
          } else {
            if (streamingCameras && streamingCameras.length > 0) {
              playVideo (streamingCameras[0].key)
            }
          }
        },
        // Note: it's important to handle errors here
        // instead of a catch() block so that we don't swallow
        // exceptions from actual bugs in components.
        (error) => {
          setData({...init_data, status: 'error', message: error})
          console.warn(error)
        }
      )
  }
  React.useEffect(getServerData, [])


  function playVideo(cKey, mKey) {
    console.log (`playVideo cameraKey=${cKey} mKey=${mKey}`)
    const mPlayer = playerRef.current
    const camera = cKey && data.cameras.find(c => c.key === cKey)
    if (cKey && mPlayer && (!currentPlaying || (currentPlaying.cKey !== cKey || currentPlaying.mKey !== mKey))) {

      setCurrentPlaying({ cKey, mKey})
      mPlayer.src({
        src: `/video/${mKey || `live/${cKey}`}/stream.m3u8${mKey && camera ? `?preseq=${camera.segments_prior_to_movement}&postseq=${camera.segments_post_movement}` : ''}`,
        type: 'application/x-mpegURL'
      })

      if (mKey && camera) {
        mPlayer.currentTime(camera.segments_prior_to_movement * 2) // 20 seconds into stream (coresponds with 'segments_prior_to_movement')
      }
      mPlayer.play()
    } else {
      console.warn(`playVideo : player not ready or cannot find camera, or already playing selected camera/movement`)
    }
  }

  
  const _selection = new Selection({
    getKey: function (m) { return  m.key },
    onSelectionChanged: function () {
      //console.log (`onSelectionChanged: getSelectedIndices()=${JSON.stringify(_selection.getSelectedIndices())}, getSelection()=${JSON.stringify(_selection.getSelection())}`)
      const selectedItems = _selection.getSelection()
      if (selectedItems.length > 0) {
        const {key, cameraKey} = selectedItems[0]
        playVideo(cameraKey, key)
      }
    }
  })

  function downloadMovement() {
    if (currentPlaying && currentPlaying.cKey && currentPlaying.mKey) {
      const c = data.cameras.find(c => c.key === currentPlaying.cKey)
      window.open(`/mp4/${currentPlaying.mKey}${c ? `?preseq=${c.segments_prior_to_movement}&postseq=${c.segments_post_movement}` : ''}`, '_blank').focus()
    }
  }


  function filterIgnoreTags(cameraKey, ml) {
    if (ml && ml.success && Array.isArray(ml.tags) && ml.tags.length > 0) {
      const { ignore_tags } = data.cameras.find(c => c.key === cameraKey) || {}
      if (ignore_tags && Array.isArray(ignore_tags) && ignore_tags.length > 0) {
        return ml.tags.reduce((a, c) => ignore_tags.includes(c.tag) ? a : a.concat(c), [])
      } else {
        return ml.tags
      }
    }
    return []
  }

  function renderTags(selectedList, idx) {

    if (false) {
    return <a target="_blank" href="http://www.google.com"><Stack>{[{tag: "tag1", probability: 100},{tag: "tag1", probability: 100}].map((t, idx) => <Text key={idx} variant="mediumPlus" >{t.tag} ({t.probability})</Text>)}</Stack></a>
    }

    const { key, cameraKey, ml, ffmpeg} = selectedList
    const img = `/image/${key}`

    if (ml) {
      if (ml.success) {
        const filteredTags = filterIgnoreTags(cameraKey, ml)
        if (filteredTags.length > 0) {
          return <a target="_blank" href={img}><Stack>{filteredTags.map((t, idx) => <Text key={idx} variant="mediumPlus" >{t.tag} ({t.probability})</Text>)}</Stack></a>
        } else {
          return <a target="_blank" href={img}><Text variant="mediumPlus" >ML Image</Text></a>
        }
      } else {
        return <Text styles={{ root: {color: 'red'}}} variant="mediumPlus">{ml.code}: {ml.stderr} {ml.error}</Text>
      }
    } else if (ffmpeg) {
      if (ffmpeg.success) {
        return <a key={idx} target="_blank" href={img}><Text variant="mediumPlus">Image</Text></a>
      } else {
        return <Text variant="mediumPlus">Error: {ffmpeg.stderr}</Text>
      }
    } else {
      return <Text variant="mediumPlus">please wait..</Text>
    }
  }

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
    <main >

      <nav className="header">
        <div className="logo">Home Surveillance</div>
        <input className="menu-btn" type="checkbox" id="menu-btn" />
        <label className="menu-icon" htmlFor="menu-btn"><span className="navicon"></span></label>
        <ul className="menu">
          <li><a href="/grafana/?orgId=1">Grafana</a></li>
          <li><a href="/network">Network Control</a></li>
        </ul>
      </nav>

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

      <div style={{ "height": "34px", "width": "100%" }} />

      <Stack horizontal wrap >


        {showPlayer &&
          <Stack.Item styles={{ root: { width: "700px" } }} grow={1}>
            <VideoJS width="640" height="268" options={{
                autoplay: true,
                muted:"muted",
                controls: true,
                aspectRatio: '4:3',
                liveui: true
              }} onReady={handlePlayerReady}/>


          </Stack.Item>
        }

        <Stack.Item styles={showPlayer ? { root: { maxWidth: "420px" } } : {}} grow={1}>

          <CommandBar
            items={[
              {
                key: 'camera',
                text: currentPlaying ? data.cameras.find(c => c.key === currentPlaying.cKey)?.name : 'Live',
                split: true,
                cacheKey: 'myCacheKey', // changing this key will invalidate this item's cache
                iconProps: { iconName: 'Webcam2' },
                onClick: () => {
                  currentPlaying && playVideo(currentPlaying.cKey)
                },
                subMenuProps: {
                  items: data.cameras.filter(c => c.enable_streaming).map(c => { return {
                      key: c.key,
                      text: c.name,
                      iconProps: { iconName: 'FrontCamera' },
                      onClick: () => playVideo(c.key)
                    }})/*.concat([{
                      key: 'all',
                      text: 'All',
                      iconProps: { iconName: 'FrontCamera' },
                      onClick: () => playVideo('all')
                    }])*/
                }
              },
              {
                key: 'refresh',
                text: 'Refresh',
                checked: data.status === "fetching",
                iconProps: { iconName: 'Refresh' },
                onClick: getServerData,
              },
              {
                key: 'download',
                text: 'Download',
                iconProps: { iconName: 'Download' },
                onClick: downloadMovement,
              },
              {
                key: 'filter',
                text: 'Filter',
                iconProps: { iconName: taggedOnly? 'Filter': 'ClearFilter' },
                checked: taggedOnly,
                onClick: () => setTaggedOnly(!taggedOnly)
              },
            ]}
            farItems={[{
              key: 'tile',
              text: 'Image view',
              // This needs an ariaLabel since it's icon-only
              ariaLabel: 'Image view',
              iconOnly: true,
              checked: !showPlayer,
              iconProps: { iconName: 'Tiles' },
              onClick: () => setShowPlayer(!showPlayer)
            },{
              key: 'settings',
              text: 'Settings',
              // This needs an ariaLabel since it's icon-only
              ariaLabel: 'Settings',
              iconOnly: true,
              iconProps: { iconName: 'Settings' },
              subMenuProps: {
                items: [{
                    key: 'settings',
                    text: 'Settings',
                    iconProps: { iconName: 'DataManagementSettings' },
                    onClick: () => {
                      setPanel({...panel, open: true, key: 'settings', invalidArray:[], heading: 'General and Disk Settings', values: {
                        disk_base_dir: data.config.settings.disk_base_dir,
                        enable_cleanup: data.config.settings.enable_cleanup,
                        cleanup_interval: data.config.settings.cleanup_interval,
                        cleanup_capacity: data.config.settings.cleanup_capacity,
                        enable_ml: data.config.settings.enable_ml,
                        darknetDir: data.config.settings.darknetDir
                      }})
                    }
                }].concat(data.cameras.map(c => { return {
                    key: c.key,
                    text: `Settings "${c.name}"`,
                    iconProps: { iconName: 'FrontCamera' },
                    ['data-automation-id']: 'newEmailButton', // optional
                    onClick: () => {
                      setPanel({...panel, open: true, key: 'edit', invalidArray: [],  heading: 'Edit Camera Details', values: {
                        key: c.key,
                        name: c.name,
                        folder: c.folder,
                        disk: c.disk,
                        secWithoutMovement: c.secWithoutMovement,
                        mSPollFrequency: c.mSPollFrequency,
                        segments_prior_to_movement: c.segments_prior_to_movement,
                        segments_post_movement: c.segments_post_movement,
                        ignore_tags: c.ignore_tags,
                        enable_streaming: c.enable_streaming,
                        enable_movement: c.enable_movement,
                      }})
                    }
                  }}).concat (
                  {
                    key: 'Add',
                    text: 'Add Camera',
                    iconProps: { iconName: 'Add' },
                    onClick: () => setPanel({...panel, open: true, key: 'new', invalidArray: [], heading: 'Add New Camera', values: {
                      secWithoutMovement: 10,
                      mSPollFrequency: 1000,
                      disk: data.config.settings.disk_base_dir,
                      segments_prior_to_movement: 10, // 20 seconds (2second segments)
                      segments_post_movement: 10, // 20 seconds (2second segments)
                      ignore_tags: ['car'],
                      enable_streaming: true,
                      enable_movement: true,
                    }}),
                  }
                ))
              }
            }]}
            ariaLabel="Inbox actions"
            primaryGroupAriaLabel="Email actions"
            farItemsGroupAriaLabel="More actions"
          />
          <ThemeProvider theme={appTheme}>
              <DetailsList
                styles={{root:{ overflow: "auto", width: "100vw", height: "calc(100vh - 40px)"}}}
                isHeaderVisible={false}
                items={(taggedOnly ? data.movements.filter(({movement}) => movement && filterIgnoreTags(movement.cameraKey, movement.ml).length > 0) : data.movements).map(m => { 
                  const camera =  data.cameras.find(c => c.key === m.movement.cameraKey)
                  return  {key: m.key, ...m.movement, startDate_en_GB: m.startDate_en_GB, cameraName: camera? camera.name: `${m.cacheKey} Not Found`}
                })}
                compact={true}
                setKey="key"
                //listProps={state}
                columns={[
                  {
                    key: "startDate_en_GB", 
                    isRowHeader: true,
                    fieldName: "startDate_en_GB",
                    minWidth: 120,
                    maxWidth: 120
                  },
                  {
                    key: "cameraName", 
                    fieldName: "cameraName",
                    minWidth: 38,
                    maxWidth: 38
                    //onRender: (item) => <Text variant='medium' styles={{root: {background: 'yellow'}}} >{item.cameraName}</Text>
                  },
                  {
                    key: "seconds", 
                    fieldName: "seconds",
                    minWidth: 25,
                    maxWidth: 30
                  }
                ].concat(showPlayer ? {
                  name: "Save", 
                  key: "stat",  
                  onRender: renderTags
                } : [])
                }
                selection={_selection}
                //selectionMode={SelectionMode.single}
                //onActiveItemChanged={_onActiveItemChanged}
              />
           
          </ThemeProvider>
        </Stack.Item>


      </Stack>
    </main >
  )
}

export default App;
