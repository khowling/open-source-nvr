//import logo from './logo.svg';
import './App.css';
import React, { useEffect }  from 'react';
import videojs from 'video.js'
import { PanelSettings } from './PanelSettings.js'
import { ToolbarGroup, Badge, Text, Button, Portal, Toolbar, Menu, MenuTrigger, Tooltip, SplitButton, MenuPopover, MenuList, MenuItem, ToolbarButton, ToolbarDivider, createTableColumn, TableCellLayout, Spinner } from "@fluentui/react-components";
import {
  DataGridBody,
  DataGrid,
  DataGridRow,
  DataGridHeader,
  DataGridCell,
  DataGridHeaderCell,
} from "@fluentui-contrib/react-data-grid-react-window";
import { ArrowMove20Regular, AccessibilityCheckmark20Regular, AccessTime20Regular, Settings16Regular, ArrowDownload16Regular, DataUsageSettings20Regular, Tv16Regular, Video20Regular, VideoAdd20Regular, ArrowRepeatAll20Regular, Filter20Regular } from "@fluentui/react-icons";


export const VideoJS = ({options, onReady, play}) => {
  const videoRef = React.useRef(null);
  const playerRef = React.useRef(null);

  React.useEffect(() => {

    // Make sure Video.js player is only initialized once
    if (!playerRef.current) {
      // The Video.js player needs to be _inside_ the component el for React 18 Strict Mode. 
      const videoElement = document.createElement("video-js");

      videoElement.classList.add('vjs-4-3');
      videoRef.current.appendChild(videoElement);

      const player = playerRef.current = videojs(videoElement, options, () => {
        videojs.log('player is ready');
        onReady && onReady(player);
      });

    // You could update an existing player in the `else` block here
    // on prop change, for example:
    } else if (play) {

      const { cKey, mKey, mStartSegment, mSeconds, segments_prior_to_movement, segments_post_movement} = play
      const player = playerRef.current;

      if (!player) {
        console.warn('VideoJS: player not ready yet');
        return;
      }

      player.src({
        src: `/video/${mKey ? `${mStartSegment}/${mSeconds}` : 'live' }/${cKey}/stream.m3u8${(mKey && segments_prior_to_movement) ? `?preseq=${segments_prior_to_movement}&postseq=${segments_post_movement}` : ''}`,
        type: 'application/x-mpegURL'
      })

   
      if (mKey && segments_prior_to_movement) {
        player.currentTime(segments_prior_to_movement * 2) // 20 seconds into stream (coresponds with 'segments_prior_to_movement')
      }
      
      console.log ('VideoJS: play()')
      player.play()

      //player.autoplay(options.autoplay);
      //player.src(options.sources);
    }
  }, [options, videoRef, play]);

  // Dispose the Video.js player when the functional component unmounts
  React.useEffect(() => {
    const player = playerRef.current;

    return () => {
      if (player && !player.isDisposed()) {
        player.dispose();
        playerRef.current = null;
      }
    };
  }, [playerRef]);

  return (
    <div data-vjs-player>
      <div ref={videoRef} />
    </div>
  );
}

function App() {

  const [currentPlaying, setCurrentPlaying] = React.useState(null)
  //const videoElement = document.getElementById("video");
  
  const playerRef = React.useRef(null);
  
  function playVideo(cKey, mKey, mStartSegment, mSeconds, segments_prior_to_movement, segments_post_movement) {
    console.log (`App() : playVideo :   cameraKey=${cKey} mKey=${mKey} (${mStartSegment}/${mSeconds}) (prior:${segments_prior_to_movement}/post:${segments_post_movement})`)
    const mPlayer = playerRef.current
    //console.log ("playVideo data: ", data)
    //const camera = cKey && data.cameras.find(c => c.key === cKey)
    if (cKey && mPlayer && (!currentPlaying || (currentPlaying.cKey !== cKey || currentPlaying.mKey !== mKey))) {

      setCurrentPlaying({ cKey, mKey, mStartSegment, mSeconds, segments_prior_to_movement, segments_post_movement})
      
      
    } else {
      console.warn(`App() : playVideo : player not ready or cannot find camera, or already playing selected camera/movement`)
    }
  }

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
/*
  React.useEffect(() => {
    // make sure Video.js player is only initialized once
    if (!playerRef.current) {
      if (!videoElement) return;

      const player = playerRef.current = videojs(videoElement, { 
        autoplay: true,
        muted:"muted",
        controls: true,
        liveui: true,
      }, () => {
        console.log("player is ready");
        handlePlayerReady(player);
      });
    } else {
      // you can update player here [update player through props]
      // const player = playerRef.current;
      // player.autoplay(options.autoplay);
      // player.src(options.sources);
    }
  }, []);
*/
  return (
    <div className="container">
          <VideoJS options={{
              autoplay: true,
              muted:"muted",
              controls: true,
              liveui: true
          }} onReady={handlePlayerReady} play={currentPlaying}/>
        <div>
          <CCTVControl playVideo={playVideo} currentPlaying={currentPlaying}/>
        </div>
      </div>
  )
  
  
}

function CCTVControl({currentPlaying, playVideo}) {

  const [panel, setPanel] = React.useState({open: false, invalidArray: []});

  const init_data = { cameras: [], movements: [] }
  const [data, setData] = React.useState(init_data)
  
  const [mode, setMode] = React.useState('Filtered')
  const [showPlayer, setShowPlayer] = React.useState(true)

  function getServerData() {
    console.log ('getServerData, mode=', mode)
    setData({...init_data, status: 'fetching'})
    fetch(`/api/movements?mode=${mode}`)
      .then(res => res.json())
      .then(
        (result) => {
          setData({...result, status: 'success'})

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

  
  useEffect(getServerData, [mode])

  
const onSelectionChange = (_, d) => {
  console.log ('onselection')
  if (d.selectedItems.size > 0) {
    const {key, movement} = data.movements.find(m => m.key === [...d.selectedItems][0])
    const { cameraKey, startSegment, seconds } = movement
    const { segments_prior_to_movement, segments_post_movement } = data.cameras.find(c => c.key === cameraKey)
    playVideo(cameraKey, key, startSegment, seconds, segments_prior_to_movement, segments_post_movement)
  }
}


  function _debug(item) {
    console.log (item)
    alert (JSON.stringify(item, null, 4))
  }

  function downloadMovement() {
    if (currentPlaying && currentPlaying.cKey && currentPlaying.mKey) {
      const c = data.cameras.find(c => c.key === currentPlaying.cKey)
      const m = data.movements.find(m => m.key === currentPlaying.mKey)
      window.open(`/mp4/${m.movement.startSegment}/${m.movement.seconds}/${m.movement.cameraKey}${(c && mode !== 'Time') ? `?preseq=${c.segments_prior_to_movement}&postseq=${c.segments_post_movement}` : ''}`, '_blank').focus()
    }
  }

  function renderTags(selectedList, idx) {
    const { key, cameraKey, ml, mlProcessing, ffmpeg } = selectedList
    const img = `/image/${key}`

    // Show spinner if ML processing is ongoing
    if (mlProcessing) {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Spinner size="tiny" />
          <Text variant="mediumPlus">Detecting...</Text>
        </div>
      )
    }

    if (ml) {
      if (ml.success) {
        if (ml.tags.length > 0) {
          // Sort tags by maxProbability descending and format with percentage
          const sortedTags = [...ml.tags].sort((a, b) => b.maxProbability - a.maxProbability)
          return (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>
              {sortedTags.map((t, idx) => {
                const frameUrl = t.maxProbabilityImage 
                  ? `/frame/${key}/${t.maxProbabilityImage}`
                  : img;
                return (
                  <a key={idx} style={{ textDecoration: "none" }} target="_blank" href={frameUrl}>
                    <Badge appearance="outline" color={idx === 0 ? "brand" : "informative"}>
                      {t.tag} ({(t.maxProbability * 100).toFixed(1)}%) {t.count > 1 && `×${t.count}`}
                    </Badge>
                  </a>
                );
              })}
            </div>
          )
        } else {
          return <a target="_blank" href={img}><Text variant="mediumPlus">ML Image</Text></a>
        }
      } else {
        return <Text styles={{ root: { color: 'red' } }} variant="mediumPlus">{ml.code}: {ml.stderr} {ml.error}</Text>
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

  return <>

      <Portal>
        <PanelSettings data={data} panel={panel} setPanel={setPanel} getServerData={getServerData}/>
      </Portal>

      <Toolbar aria-label="Default" style={{"justifyContent": "space-between" }}>

        <ToolbarGroup role="presentation">

          <ToolbarButton
            icon={<ArrowRepeatAll20Regular />}
            onClick={getServerData}
          />

          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <Button  icon={<Tv16Regular />}>{currentPlaying ? data.cameras.find(c => c.key === currentPlaying.cKey)?.name : 'Live'}</Button>
            </MenuTrigger>

            <MenuPopover>
              <MenuList>
                { data.cameras.filter(c => c.enable_streaming).map(c => 
                  <MenuItem key={c.key} icon={<Video20Regular />}  onClick={() => playVideo(c.key)}>{c.name}</MenuItem>
                )}
              </MenuList>
            </MenuPopover>
          </Menu>

          <ToolbarButton

            icon={<ArrowDownload16Regular />}
            onClick={downloadMovement}
          />

          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <Button  icon={<Filter20Regular />}>{mode}</Button>
            </MenuTrigger>

            <MenuPopover>
              <MenuList>
                <MenuItem key="movement" icon={<ArrowMove20Regular/>} onClick={ () => setMode ('Movement')}>All Movement</MenuItem>
                <MenuItem key="Filtered" icon={<AccessibilityCheckmark20Regular/>} onClick={ () => setMode ('Filtered')}>Filtered</MenuItem>
                <MenuItem key="Time"   icon={<AccessTime20Regular/>} onClick={ () => setMode ('Time')}>Time</MenuItem>
              </MenuList>
             </MenuPopover>
          </Menu>

        </ToolbarGroup>

        <ToolbarGroup role="presentation">
          <Menu positioning="below-end">
            <MenuTrigger disableButtonEnhancement>
              <Button  icon={<Settings16Regular />}></Button>
            </MenuTrigger>

            <MenuPopover>
              <MenuList>
                <MenuItem key="general" icon={<DataUsageSettings20Regular />}  onClick={() => {
                      setPanel({...panel, open: true, key: 'settings', invalidArray:[], heading: 'General Settings', values: { ...data.config.settings }})
                }}>General</MenuItem>

                { data.cameras.map(c => 
                  <MenuItem key={c.key} icon={<Video20Regular />}  onClick={() => {
                    setPanel({...panel, open: true, key: 'edit', invalidArray: [],  heading: `Edit Camera Details (${c.key})`, values: {
                      key: c.key,
                      name: c.name,
                      folder: c.folder,
                      disk: c.disk,
                      pollsWithoutMovement: c.pollsWithoutMovement,
                      secMaxSingleMovement: c.secMaxSingleMovement,
                      mSPollFrequency: c.mSPollFrequency,
                      segments_prior_to_movement: c.segments_prior_to_movement,
                      segments_post_movement: c.segments_post_movement,
                      ignore_tags: c.ignore_tags,
                      enable_streaming: c.enable_streaming,
                      enable_movement: c.enable_movement,
                    }})
                  }}>{c.name}</MenuItem>
                )}

                <MenuItem key="add" icon={<VideoAdd20Regular />}  onClick={() => {
                      setPanel({...panel, open: true, key: 'new', invalidArray: [], heading: 'Add New Camera', values: {
                        pollsWithoutMovement: 1,
                        secMaxSingleMovement: 600,
                        mSPollFrequency: 1000,
                        disk: data.config.settings.disk_base_dir,
                        segments_prior_to_movement: 10, // 20 seconds (2second segments)
                        segments_post_movement: 10, // 20 seconds (2second segments)
                        ignore_tags: ['car'],
                        enable_streaming: true,
                        enable_movement: true,
                      }})
                    }}>Add</MenuItem>
                
              </MenuList>
            </MenuPopover>
          </Menu>
        </ToolbarGroup>

      </Toolbar>

      

      <DataGrid
        size="small"
        selectionMode="single"
        onSelectionChange={onSelectionChange}
        getRowId={(item) => item.key}
        columns={[
          createTableColumn({
            columnId: "startDate_en_GB",
            renderCell: (item) => {
              return (
                <TableCellLayout>{item.startDate_en_GB} ({item.seconds}s)</TableCellLayout>
              )
            }

          }),
          createTableColumn({
            columnId: "cameraName",
            renderCell: (item) => {
              return (
                <TableCellLayout>{item.cameraName}</TableCellLayout>
              )
            }

          }),
          createTableColumn({
            columnId: "tags",
            renderCell: (item) => {
              return (
                <TableCellLayout>{renderTags(item,0)}</TableCellLayout>
              )
            }

          })
        ]}
        items={data.movements.map(m => { 
          const camera =  data.cameras.find(c => c.key === m.movement.cameraKey)
          return  {
            key: m.key,
            ...m.movement, 
            startDate_en_GB: m.startDate_en_GB, 
            ...(camera && {  cameraName: camera.name })
          }})} 
        
          
          >

          <DataGridBody itemSize={50} height={700}>
            {({ item, rowId }, style) => (
              <DataGridRow key={rowId} style={style}>
                {({ renderCell }) => (
                  <DataGridCell>{renderCell(item)}</DataGridCell>
                )}
              </DataGridRow>
            )}
          </DataGridBody>
      </DataGrid>

  </>
}

export default App;
