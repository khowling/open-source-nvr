//import logo from './logo.svg';
import './App.css';
import React, { /* useCallback , */ useRef, useEffect } from 'react';
import videojs from 'video.js'
import { CommandBar, Text, Toggle, DefaultButton, DetailsList, SelectionMode, Stack, TextField, Slider, TagPicker, Separator, Label, MessageBar, MessageBarType, Checkbox, Selection, PrimaryButton, Panel, VerticalDivider } from '@fluentui/react'
import { initializeIcons } from '@fluentui/react/lib/Icons';

initializeIcons(/* optional base url */);

function App() {

  const [panel, setPanel] = React.useState({open: false});
  const [error, setError] = React.useState(null)
  const [invalidArray, setInvalidArray] = React.useState([])

  const [data, setData] = React.useState({ cameras: [], movements: [] })
  const [currentCamera, setCurrentCamera] = React.useState(null)
  const [inputState, setInputState] = React.useState({ current_idx: 'none', allSelected: false, inputs: {} })
  const [taggedOnly, setTaggedOnly] = React.useState(true)
  const [showPlayer, setShowPlayer] = React.useState(true)
  const [playerReady, setPlayerReady] = React.useState(false)

  let video_ref = useRef(null)
  useEffect(() => {
    if (showPlayer) {
      console.log(`useEffect: initialising videojs on ${video_ref.current}`)
      let mPlayer = videojs(video_ref.current, {
        autoplay: true,
        controls: true,
        aspectRatio: '4:3',
        liveui: true
      }, () => {
        console.log('player ready')
        setPlayerReady(true)
        if (data.cameras.length > 0) {
          playVideo(data.cameras[0])
        }

      })

      return () => {
        console.log(`useEffect: dispose return`)
        setPlayerReady(false)
        if (mPlayer) mPlayer.dispose()
      }
    } else {
      console.log(`useEffect: disposing videojs on ${video_ref.current}`)
      setPlayerReady(false)
      if (video_ref.current) {
        videojs(video_ref.current).dispose()
      }
    }
  }, [video_ref, showPlayer])

  function getServerData() {

    fetch(`/api/movements`)
      .then(res => res.json())
      .then(
        (result) => {
          setData(result)
        },
        // Note: it's important to handle errors here
        // instead of a catch() block so that we don't swallow
        // exceptions from actual bugs in components.
        (error) => {
          console.warn(error)
        }
      )
  }
  useEffect(getServerData, [])



  function _onItemInvoked(m, idx) {
    setInputState({ ...inputState, inputs: { ...inputState.inputs, [m.key]: { reviewed: false } } })
  }

  function _itemChanged(m, idx) {
    // (_section.isAllSelected ${_selection.isAllSelected()})
    console.log(`_itemChanged ${idx} (old ${inputState.current_idx})  (allSelected ${inputState.allSelected})`)
    if (idx !== inputState.current_idx) {
      setInputState({ current_idx: idx, current_movement: m, allSelected: inputState.allSelected, inputs: { ...inputState.inputs, [m.key]: { reviewed: true } } })
    }
    if (playerReady) {
      playVideo(data.cameras.find(c => c.key === m.movement.cameraKey), m.key)
    }
  }

  function playVideo(camera, movementKey) {
    if (video_ref.current) {
      let mPlayer = videojs(video_ref.current)

      mPlayer.src({
        src: `/video/${movementKey || `live/${camera.key}`}/stream.m3u8${movementKey ? `?preseq=${camera.segments_prior_to_movement}&postseq=${camera.segments_post_movement}` : ''}`,
        type: 'application/x-mpegURL'
      })
      if (movementKey) {
        mPlayer.currentTime(camera.segments_prior_to_movement * 2) // 20 seconds into stream (coresponds with 'segments_prior_to_movement')
      }
      mPlayer.play()
    }
  }

  function reloadlist() {
    setInputState({ current_idx: 'none', allSelected: inputState.allSelected, inputs: {} })
    getServerData()
  }

  const _selection = new Selection({
    //isAllSelected: (e) => {
    onSelectionChanged: function () {
      console.log(`onSelectionChanged ${_selection.isAllSelected()}, current idx ${inputState.current_idx}`)
      //setInputState({ ...inputState, allSelected: _selection.isAllSelected() })

    }
  })



  function recordReview() {
    console.log(inputState.current_movement)
    if (playerReady && inputState.current_movement) {
      let mPlayer = videojs(video_ref.current)
      console.log(mPlayer.currentTime())
      const c = data.cameras.find(c => c.key === inputState.current_movement.movement.cameraKey)
      window.open(`/mp4/${inputState.current_movement.key}${c ? `?preseq=${c.segments_prior_to_movement}&postseq=${c.segments_post_movement}` : ''}`, '_blank').focus()
    }

  }

  function filterIgnoreTags(event) {
    const { movement } = event
    if (movement && movement.ml && movement.ml.success && Array.isArray(movement.ml.tags) && movement.ml.tags.length > 0) {
      const { ignore_tags } = data.cameras.find(c => c.key === movement.cameraKey) || {}
      if (ignore_tags && Array.isArray(ignore_tags) && ignore_tags.length > 0) {
        return movement.ml.tags.reduce((a, c) => ignore_tags.includes(c.tag) ? a : a.concat(c), [])
      } else {
        return movement.ml.tags
      }
    }
    return []
  }

  function renderTags(event, idx) {

    const { key, movement } = event
    const img = `/image/${key}`

    if (movement.ml) {
      if (movement.ml.success) {
        const filteredTags = filterIgnoreTags(event)
        if (filteredTags.length > 0) {
          return filteredTags.map((t, idx) => <div><a key={idx} target="_blank" href={img}><Text variant="mediumPlus" >{t.tag} ({t.probability}); </Text></a></div>)
        } else {
          return <a key={idx} target="_blank" href={img}><Text variant="mediumPlus" >ML Image</Text></a>
        }
      } else {
        return <Text variant="mediumPlus">ML error: {movement.ml.stderr}</Text>
      }
    } else if (movement.ffmpeg) {
      if (movement.ffmpeg.success) {
        return <a key={idx} target="_blank" href={img}><Text variant="mediumPlus">Image (wait for ML)</Text></a>
      } else {
        return <Text variant="mediumPlus">Error: {movement.ffmpeg.stderr}</Text>
      }
    } else {
      return <Text variant="mediumPlus">please wait..</Text>
    }
  }

  function playLive(cKey) {
    setCurrentCamera(cKey)
    if (playerReady) {
      console.log(`playing ${cKey}`)
      playVideo(data.cameras.find(c => c.key === cKey))
    } else {
      alert("Player not ready")
    }
  }

  function updatePanelValues(field, value) {
    var calcFolder = panel.values.folder || ''
    if (field === "name") {
      if (!calcFolder) {
        calcFolder = `./test_video/${value}`
      } else if (calcFolder.includes(panel.values.name)) {
        calcFolder = calcFolder.replace(panel.values.name, value)
      }
    }


    setPanel({...panel, values: {...panel.values, 
      [field]: value, 
      ...(field === "enable_streaming" && value === false && {enable_movement: false}),
      ...(field !== 'folder' && {folder: calcFolder})
    }})
  }

  function getError(field) {
    const idx = invalidArray.findIndex(e => e.field === field)
    return idx >= 0 ? invalidArray[idx].message : ''
  }

  function invalidFn(field, invalid, message) {
    const e = invalidArray.find(e => e.field === field)
    if (!invalid && e) {
      setInvalidArray((prev) => prev.filter((e) => e.field !== field))
    } else if (invalid && !e) {
      setInvalidArray((prev) => prev.concat({ field, message }))
    }
  }

  if (panel.open) {
    invalidFn('name', !panel.values.name || panel.values.name.match(/^[a-z0-9][_\-a-z0-9]+[a-z0-9]$/i) === null || panel.values.name>19,
      <Text>Enter valid camera name</Text>)
      if (panel.key === "new") {
        invalidFn('ip', !panel.values.ip || panel.values.ip.match(/^([0-9]{1,3}\.){3}[0-9]{1,3}$/i) === null,
          <Text>Enter valid camera IPv4 address</Text>)
      } else {
        invalidFn('ip', panel.values.ip && panel.values.ip.match(/^([0-9]{1,3}\.){3}[0-9]{1,3}$/i) === null,
          <Text>Enter valid camera IPv4 address</Text>)
      }
  }

  const testTags= [
      'black',
      'blue',
      'brown',
      'cyan',
      'green',
      'magenta',
      'mauve',
      'orange',
      'pink',
      'purple',
      'red',
      'rose',
      'violet',
      'white',
      'yellow',
    ].map(item => ({ key: item, name: item }));

  const listContainsTagList = (tag, tagList) => {
      if (!tagList || !tagList.length || tagList.length === 0) {
        return false;
      }
      return tagList.some(compareTag => compareTag.key === tag.key);
  }

  function savePanel() {
    setError(null)
    fetch(`/api/camera/${panel.key}`, {
      method: 'POST',
      credentials: 'same-origin',
      mode: 'cors',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(panel.values)
    }).then(succ => {
      if (succ.ok) {
        console.log(`created success : ${JSON.stringify(succ)}`)
        setPanel({open: false})
      } else {
        const ferr = `created failed : ${succ.status} ${succ.statusText}`
        console.error(ferr)
        setError(ferr)
      }
      
    }).catch(error => {
      console.error(`created failed : ${error}`)
      setError(`created failed : ${error}`)
    })
  }

  return (
    <main id="mainContent" data-grid="container">

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
        headerText="Camera Details"
        isOpen={panel.open}
        onDismiss={() => setPanel({...panel, open: false})}
        // You MUST provide this prop! Otherwise screen readers will just say "button" with no label.
        closeButtonAriaLabel="Close"
      >
          { panel.open && 
          <>
            <TextField label="Camera Name" required onChange={(ev, val) => updatePanelValues('name', val)} required errorMessage={getError('name')} value={panel.values.name} />
            <TextField label="IP Address" prefix="IP" onChange={(ev, val) => updatePanelValues('ip', val)} required errorMessage={getError('ip')} value={panel.values.ip} />
            <TextField label="admin Password" type="password"  value={panel.values.passwd} onChange={(ev, val) => updatePanelValues('passwd', val)} />
            
            <TextField label="Media Folder" iconProps={{ iconName: 'Folder' }}  required value={panel.values.folder} onChange={(ev, val) => updatePanelValues('folder', val)} />

            <Label>Filter Tags</Label>
            <TagPicker
              onChange={(i) => panel.values.ignore_tags = i.map(i => i.key)}
              defaultSelectedItems={panel.values.ignore_tags ? panel.values.ignore_tags.map(i => {return {key:i,name:i}} ) : []}
              removeButtonAriaLabel="Remove"
              selectionAriaLabel="Selected colors"
              onResolveSuggestions={(filterText, tagList) => {
                return filterText
                  ? testTags.filter(
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
            <Stack styles={{ root: { marginTop: "15px !important"} }}>
              <Slider disabled={!panel.values.enable_streaming} label="Segments(2s) prior to movement" min={0} max={60} step={1} defaultValue={panel.values.segments_prior_to_movement} showValue onChange={(val) => updatePanelValues('segments_prior_to_movement', val)} />
              <Slider disabled={!panel.values.enable_streaming} label="Segments(2s) post movement" min={0} max={60} step={1} defaultValue={panel.values.segments_post_movement} showValue onChange={(val) => updatePanelValues('segments_post_movement', val)} />
            </Stack>

            <Separator styles={{ root: { marginTop: "15px !important", marginBottom: "5px" } }}><b>Movement processing</b></Separator>
            
            <Checkbox disabled={!panel.values.enable_streaming} label="Enable Movement" checked={panel.values.enable_movement} onChange={(ev, val) => updatePanelValues('enable_movement', val)} />
            <Stack styles={{ root: { marginTop: "15px !important"} }}>
              <Slider disabled={!panel.values.enable_movement} label="Poll Frequency (mS)" min={1000} max={10000} step={500} defaultValue={panel.values.mSPollFrequency} showValue onChange={(val) => updatePanelValues('mSPollFrequency', val)} />
              <Slider disabled={!panel.values.enable_movement} label="Seconds without movement" min={0} max={50} step={1} defaultValue={panel.values.secWithoutMovement} showValue onChange={(val) => updatePanelValues('secWithoutMovement', val)} />
            </Stack>


            <PrimaryButton styles={{ root: { marginTop: "15px !important"}}} disabled={invalidArray.length >0} text="Save" onClick={savePanel}/>

            {error &&
            <MessageBar messageBarType={MessageBarType.error} isMultiline={false} truncated={true}>
              {error}
            </MessageBar>
          }
        </>
      }

      </Panel>

      <div style={{ "height": "43px", "width": "100%" }} />

      <Stack horizontal wrap >
        {showPlayer &&
          <Stack.Item styles={{ root: { width: "700px" } }} grow={1}>
            <video ref={video_ref} className="video-js vjs-default-skin" width="640" height="268" />
          </Stack.Item>
        }

        <Stack.Item styles={showPlayer ? { root: { width: "300px" } } : {}} grow={1}>


          <Stack horizontal>
            <Toggle inlineLabel onText="Tag'd" offText="All" styles={{ root: { "marginTop": "5px" } }} onChange={(e, val) => setTaggedOnly(val)} checked={taggedOnly} />
            <Toggle inlineLabel onText="Video" offText="Image" styles={{ root: { "marginTop": "5px" } }} onChange={(e, val) => setShowPlayer(val)} checked={showPlayer} />
            <PrimaryButton styles={{ root: { minWidth: '50px' } }} onClick={recordReview} >Export</PrimaryButton>
            <DefaultButton styles={{ root: { minWidth: '50px' } }} onClick={reloadlist} >Refresh</DefaultButton>
            <DefaultButton split menuProps={{ items: data.cameras.map(c => { return { key: c.name, text: c.name, onClick: playLive } }) }}  >Live</DefaultButton>
          </Stack>

          <CommandBar
            items={[
              {
                key: 'camera',
                text: `Live ${currentCamera ? data.cameras.find(c => c.key === currentCamera).name : ''}`,
                cacheKey: 'myCacheKey', // changing this key will invalidate this item's cache
                iconProps: { iconName: 'Webcam2' },
                subMenuProps: {
                  items: data.cameras.map(c => { return {
                      key: c.key,
                      text: c.name,
                      iconProps: { iconName: 'FrontCamera' },
                      ['data-automation-id']: 'newEmailButton', // optional
                      onClick: () => playLive(c.key)
                    }}).concat (
                    {
                      key: 'Add',
                      text: 'Add',
                      iconProps: { iconName: 'Add' },
                      onClick: () => setPanel({...panel, open: true, key: 'new', values: {
                        secWithoutMovement: 10,
                        mSPollFrequency: 1000,
                        segments_prior_to_movement: 10, // 20 seconds (2second segments)
                        segments_post_movement: 10, // 20 seconds (2second segments)
                        ignore_tags: ['car'],
                        enable_streaming: true,
                        enable_movement: true
                      }}),
                    }
                  )
                },
              },
              {
                key: 'download',
                text: 'Download',
                iconProps: { iconName: 'Download' },
                onClick: () => console.log('Download'),
              },
              {
                key: 'refresh',
                text: 'Refresh',
                iconProps: { iconName: 'Refresh' },
                onClick: reloadlist,
              },
              {
                key: 'filter',
                text: 'Filter',
                iconProps: { iconName: 'Filter' },
                onClick: () => console.log('Filter')
              },
            ]}
            farItems={[{
              key: 'tile',
              text: 'Image view',
              // This needs an ariaLabel since it's icon-only
              ariaLabel: 'Image view',
              iconOnly: true,
              iconProps: { iconName: 'Tiles' },
              onClick: () => console.log('Tiles')
            },{
              key: 'settings',
              text: 'Settings',
              // This needs an ariaLabel since it's icon-only
              ariaLabel: 'Settings',
              iconOnly: true,
              iconProps: { iconName: 'Settings' },
              onClick: () => {
                if (currentCamera) {
                  const cc = data.cameras.find(c => c.key === currentCamera)
                  setPanel({...panel, open: true, key: currentCamera, values: {
                    name: cc.name,
                    folder: cc.folder,
                    secWithoutMovement: cc.secWithoutMovement,
                    mSPollFrequency: cc.mSPollFrequency,
                    segments_prior_to_movement: cc.segments_prior_to_movement,
                    segments_post_movement: cc.segments_post_movement,
                    ignore_tags: cc.ignore_tags,
                    enable_streaming: cc.enable_streaming,
                    enable_movement: cc.enable_movement
                  }})
                }
              }
            }]}
            ariaLabel="Inbox actions"
            primaryGroupAriaLabel="Email actions"
            farItemsGroupAriaLabel="More actions"
          />

          <DetailsList
            isHeaderVisible={false}
            items={taggedOnly ? data.movements.filter(m => filterIgnoreTags(m).length > 0) : data.movements}
            compact={true}
            //listProps={state}
            columns={[
              {
                name: "Reviewed Movement (seconds)", key: "start", minWidth: 200, ...(showPlayer && { maxWidth: 200 }), onRender: (m, idx) =>
                  <div>
                    <Text key={idx + 1} variant="mediumPlus">{m.startDateGb} ({m.movement.seconds}s {m.movement.cameraName})</Text>
                    {!showPlayer && <div key={idx + 2}><img src={`/image/${m.key}`} style={{ maxWidth: "100%" }} /></div>}
                  </div>


              }
            ].concat(showPlayer ? {
              name: "Save", key: "stat", minWidth: 80, maxWidth: 80, onRender: renderTags
            } : [])
            }
            selectionMode={SelectionMode.single}
            onActiveItemChanged={_itemChanged}
            onItemInvoked={_onItemInvoked}
          />

        </Stack.Item>


      </Stack>
    </main >
  );
}

export default App;
