import React  from 'react';

import {
  Text, 
  Select,
  Dropdown,
  Divider,
  Input,
  Checkbox,
  Slider,
  makeStyles,
  tokens,
  useId,
  Label,
  Badge,
  Textarea,
  shorthands,
  Combobox,
  Option,
  Dialog,
  DialogSurface,
  DialogTitle,
  DialogContent,
  DialogActions,
  DialogTrigger,
  DialogBody,
  Button,
  Menu,
  MenuTrigger,
  SplitButton,
  MenuList,
  MenuItem,
  MenuPopover,
  Field
} from "@fluentui/react-components";
import { Alert } from '@fluentui/react-components/unstable';
import { Dismiss12Regular, Folder16Regular, KeyCommand16Regular, Camera16Regular, NetworkAdapter16Regular, Password16Regular } from "@fluentui/react-icons";


const useStyles = makeStyles({
  base: {
    display: "flex",
    flexDirection: "column",
    rowGap: tokens.spacingVerticalS,
    "& > label": {
      marginBottom: tokens.spacingVerticalMNudge,
    },
  },
  root: {
    // Stack the label above the field with a gap
    display: "grid",
    gridTemplateRows: "repeat(1fr)",
    justifyItems: "start",
    ...shorthands.gap("2px"),
    //maxWidth: "400px",
    marginTop: "15px" 
  },
  tagsList: {
    listStyleType: "none",
    marginBottom: tokens.spacingVerticalXXS,
    marginTop: 0,
    paddingLeft: 0,
    display: "flex",
    gridGap: tokens.spacingHorizontalXXS,
  },
});

export const MultiselectWithTags = ({label, options, selectedOptions, setSelectedOptions}) => {
  // generate ids for handling labelling
  const comboId = useId("combo-multi");
  const selectedListId = `${comboId}-selection`;

  // refs for managing focus when removing tags
  const selectedListRef = React.useRef(null);
  const comboboxInputRef = React.useRef(null);

  const styles = useStyles();

  // Handle selectedOptions both when an option is selected or deselected in the Combobox,
  // and when an option is removed by clicking on a tag
  //const [selectedOptions, setSelectedOptions] = React.useState<string[]>([]);

  const onSelect = (event, data) => {
    setSelectedOptions(data.selectedOptions);
  };

  const onTagClick = (option, index) => {
    // remove selected option
    setSelectedOptions(selectedOptions.filter((o) => o !== option));

    // focus previous or next option, defaulting to focusing back to the combo input
    const indexToFocus = index === 0 ? 1 : index - 1;
    const optionToFocus = selectedListRef.current?.querySelector(
      `#${comboId}-remove-${indexToFocus}`
    );
    if (optionToFocus) {
      (optionToFocus).focus();
    } else {
      comboboxInputRef.current?.focus();
    }
  };

  const labelledBy =
    selectedOptions.length > 0 ? `${comboId} ${selectedListId}` : comboId;

  return (
    <div className={styles.root}>
      <Label id={comboId}>{label}</Label>
      {selectedOptions.length ? (
        <ul
          id={selectedListId}
          className={styles.tagsList}
          ref={selectedListRef}
        >
          {/* The "Remove" span is used for naming the buttons without affecting the Combobox name */}
          <span id={`${comboId}-remove`} hidden>
            Remove
          </span>
          {selectedOptions.map((option, i) => (
            <li key={option}>
              <Button
                size="small"
                shape="circular"
                appearance="primary"
                icon={<Dismiss12Regular />}
                iconPosition="after"
                onClick={() => onTagClick(option, i)}
                id={`${comboId}-remove-${i}`}
                aria-labelledby={`${comboId}-remove ${comboId}-remove-${i}`}
              >
                {option}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Combobox
        aria-labelledby={labelledBy}
        multiselect={true}
        placeholder="Select one or more tags"
        selectedOptions={selectedOptions}
        onOptionSelect={onSelect}
        ref={comboboxInputRef}
      >
        {options.map((option) => (
          <Option key={option}>{option}</Option>
        ))}
      </Combobox>
    </div>
  );
};

export const MySplitButton = ({label, items}) => (
  <Menu positioning="below-end">
    <MenuTrigger disableButtonEnhancement>
      {(triggerProps) => (
        <SplitButton menuButton={triggerProps}>{label}</SplitButton>
      )}
    </MenuTrigger>

    <MenuPopover>
      <MenuList>
        { items.map((i, idx) =>
          <MenuItem key={idx} onClick={(event) => i.onClick(event, {key: i.key})}>{i.text}</MenuItem>  
        )}
        
      </MenuList>
    </MenuPopover>
  </Menu>
);


export function PanelSettings({panel, setPanel, data, getServerData}) {

    const [error, setError] = React.useState(null)

    const styles = useStyles();

    function updatePanelValues(field, value) {
        console.log (`updatePanelValues ${field} ${JSON.stringify(value)}`)
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
          invalidFn('detection_model', panel.values.detection_enable && (!panel.values.detection_model),
            <Text>Must select a model for object detection</Text>)
          invalidFn('detection_frames_path', panel.values.detection_enable && panel.values.detection_frames_path && (panel.values.detection_frames_path.endsWith('/')),
            <Text>Frames path cannot end with '/'</Text>)
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
    return panel.open && (

      <Dialog modalType='modal' open={panel.open}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{panel.heading}</DialogTitle>
            
            { panel.key === 'settings' ? 
              <DialogContent className={styles.base}>

                    <Divider ><b>Storage Settings</b></Divider>

                    <Field
                      label="Disk Mount Folder"
                      validationState={getError('disk_base_dir') ? "error" : "none"}
                      validationMessage={getError('disk_base_dir')}>
                      <Input style={{"width": "100%"}} contentBefore={<Folder16Regular/>} required value={panel.values.disk_base_dir} onChange={(_, data) => updatePanelValues('disk_base_dir', data.value)}  />
                    </Field>

                    <div className={styles.root}>
                      <label>Check Capacity Interval {panel.values.disk_cleanup_interval} minutes</label>
                      <Slider style={{"width": "100%"}} min={0} max={60} step={5} defaultValue={panel.values.disk_cleanup_interval} showValue onChange={(_,data) => updatePanelValues('disk_cleanup_interval', data.value)} />
                    </div>

                    <div className={styles.root}>
                      <label>Keep under Capacity {panel.values.disk_cleanup_capacity}%</label>
                      <Slider style={{"width": "100%"}} disabled={panel.values.disk_cleanup_interval === 0}  min={20} max={100} step={5} defaultValue={panel.values.disk_cleanup_capacity} showValue onChange={(_,data) => updatePanelValues('disk_cleanup_capacity', data.value)} />
                    </div>


                    <Divider><b>Object Detection</b></Divider>
                    
                    <Checkbox label="Enable Object Detection" checked={panel.values.detection_enable} onChange={(_,data) => updatePanelValues('detection_enable', data.checked)} />
                    
                    <Field
                      label="YOLO Model Path"
                      hint="Relative to ./ai directory (e.g., 'model/yolo11n.onnx' or 'model/yolo11n-rk3588.rknn')"
                      validationState={getError('detection_model') ? "error" : "none"}
                      validationMessage={getError('detection_model')}>
                      <Input 
                        style={{"width": "100%"}} 
                        disabled={!panel.values.detection_enable}
                        placeholder="model/yolo11n.onnx"
                        value={panel.values.detection_model || ''} 
                        onChange={(_, data) => updatePanelValues('detection_model', data.value)} />
                    </Field>

                    <Field
                      label="Target Platform"
                      hint="Hardware acceleration target (leave empty for CPU/ONNX)"
                      validationState={getError('detection_target_hw') ? "error" : "none"}
                      validationMessage={getError('detection_target_hw')}>  
                      <Dropdown 
                        style={{"width": "100%"}} 
                        disabled={!panel.values.detection_enable}
                        placeholder="CPU (default)"
                        value={panel.values.detection_target_hw || ''}
                        selectedOptions={panel.values.detection_target_hw ? [panel.values.detection_target_hw] : []}
                        onOptionSelect={(_, data) => updatePanelValues('detection_target_hw', data.optionValue)}>
                        <Option key="" value="">CPU (default)</Option>
                        <Option key="rk3588" value="rk3588">RK3588 (RKNN)</Option>
                        <Option key="rk3576" value="rk3576">RK3576 (RKNN)</Option>
                      </Dropdown>
                    </Field>

                    <Field
                      label="Frames Output Path"
                      hint="Relative to Base Directory above (e.g., 'frames' or 'ml_images')"
                      validationState={getError('detection_frames_path') ? "error" : "none"}
                      validationMessage={getError('detection_frames_path')}>
                      <Input 
                        style={{"width": "100%"}} 
                        disabled={!panel.values.detection_enable} 
                        contentBefore={<Folder16Regular/>}  
                        placeholder="frames"
                        value={panel.values.detection_frames_path || ''} 
                        onChange={(_, data) => updatePanelValues('detection_frames_path', data.value)} />
                    </Field>

                    <Divider><b>Tag Filters (Filtered Mode)</b></Divider>
                    
                    <Field
                      label="Minimum Probability Filters"
                      hint="Only show tags that meet or exceed their minimum probability threshold">
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' }}>
                        {(panel.values.detection_tag_filters || []).map((filter, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px', border: '1px solid #e0e0e0', borderRadius: '4px' }}>
                            <Badge appearance="outline" style={{ minWidth: '80px' }}>{filter.tag}</Badge>
                            <div style={{ flex: 1 }}>
                              <Slider 
                                min={0} 
                                max={1} 
                                step={0.05} 
                                value={filter.minProbability}
                                disabled={!panel.values.detection_enable}
                                onChange={(_, data) => {
                                  const newFilters = [...panel.values.detection_tag_filters];
                                  newFilters[idx] = { ...filter, minProbability: data.value };
                                  updatePanelValues('detection_tag_filters', newFilters);
                                }} />
                            </div>
                            <Text style={{ minWidth: '45px', textAlign: 'right' }}>
                              ≥{Math.round(filter.minProbability * 100)}%
                            </Text>
                            <Button 
                              size="small" 
                              appearance="subtle"
                              disabled={!panel.values.detection_enable}
                              onClick={() => {
                                const newFilters = panel.values.detection_tag_filters.filter((_, i) => i !== idx);
                                updatePanelValues('detection_tag_filters', newFilters);
                              }}>
                              Remove
                            </Button>
                          </div>
                        ))}
                        {(!panel.values.detection_tag_filters || panel.values.detection_tag_filters.length === 0) && (
                          <Text style={{ fontStyle: 'italic', color: '#666' }}>
                            No filters configured. Right-click any badge to add a filter.
                          </Text>
                        )}
                      </div>
                    </Field>

                    <div className={styles.root}></div>

              </DialogContent>
            :
              <DialogContent className={styles.base}>
                    
                    <Field
                      label="Camera Name"
                      validationState={getError('name') ? "error" : "none"}
                      validationMessage={getError('name')}>
                      <Input style={{"width": "100%"}} contentBefore={<Camera16Regular/>}  required value={panel.values.name} onChange={(_, data) => updatePanelValues('name', data.value)} />
                    </Field>

                    <Field
                      label="IP Address (display on create only)"
                      validationState={getError('ip') ? "error" : "none"}
                      validationMessage={getError('ip')}>
                      <Input style={{"width": "100%"}} contentBefore={<NetworkAdapter16Regular/>}  required value={panel.values.ip} onChange={(_, data) => updatePanelValues('ip', data.value)} />
                    </Field>

                    <Field
                      label="Camera Password (display on create only)"
                      validationState={getError('passwd') ? "error" : "none"}
                      validationMessage={getError('passwd')}>
                      <Input style={{"width": "100%"}} contentBefore={<Password16Regular/>}  required type="password" value={panel.values.passwd} onChange={(_, data) => updatePanelValues('passwd', data.value)} />
                    </Field>


                    <Field
                      label="Video Files"
                      validationState={getError('disk') || getError('folder') ? "error" : "none"}
                      validationMessage={getError('disk') || getError('folder')}>
                      <div>
                          <div  style={{"display": "inline-block"}} >
                          <Select style={{ "maxWidth": "150px"}} value={panel.values.disk}  required onChange={(_, data) => updatePanelValues('disk', data.value)} >
                            {data.config &&  <option>{data.config.settings.disk_base_dir}</option>  }
                          </Select>
                          </div>
                          /
                          <div  style={{"display": "inline-block"}} >
                            <Input contentAfter={<Folder16Regular/>}  required value={panel.values.folder} onChange={(_, data) => updatePanelValues('folder', data.value)} />
                          </div>
                      </div>
                    </Field>

                    
                    <Divider><b>Playback</b></Divider>

                    <Checkbox label="Enable Streaming" checked={panel.values.enable_streaming} onChange={(_,data) => { updatePanelValues('enable_streaming', data.checked)} } />

                    <div className={styles.root}>
                      <label>Playback seconds prior to movement: {panel.values.segments_prior_to_movement*2} seconds</label>
                      <Slider style={{"width": "100%"}} disabled={!panel.values.enable_streaming}  min={0} max={60} step={1} defaultValue={panel.values.segments_prior_to_movement}  onChange={(_,data) => updatePanelValues('segments_prior_to_movement', data.value)} />
                    </div>
                    
                    <div className={styles.root}>
                      <label>Playback seconds post movement: {panel.values.segments_post_movement*2} seconds</label>
                      <Slider style={{"width": "100%"}} disabled={!panel.values.enable_streaming}  min={0} max={60} step={1} defaultValue={panel.values.segments_post_movement}  onChange={(_,data) => updatePanelValues('segments_post_movement', data.value)} />
                    </div>

                    <Divider><b>Movement processing</b></Divider>
                    
                    <Checkbox disabled={!panel.values.enable_streaming} label="Enable Movement" checked={panel.values.enable_movement} onChange={(_, data) => updatePanelValues('enable_movement', data.checked)} />
                    
                    <div className={styles.root}>
                      <label>Poll Frequency: {panel.values.mSPollFrequency/1000} seconds</label>
                      <Slider style={{"width": "100%"}} disabled={!panel.values.enable_movement} min={1000} max={10000} step={500} defaultValue={panel.values.mSPollFrequency}  onChange={(_,data) => updatePanelValues('mSPollFrequency', data.value)} />
                    </div>

                    <div className={styles.root}>
                      <label>Extend capturing movement after camera reports no movement for {panel.values.pollsWithoutMovement} poll(s) (0 = stop immediately)</label>
                      <Slider style={{"width": "100%"}} disabled={!panel.values.enable_movement}  min={0} max={10} step={1} defaultValue={panel.values.pollsWithoutMovement}  onChange={(_,data) => updatePanelValues('pollsWithoutMovement', data.value)} />
                    </div>
                    
                    <div className={styles.root}>
                      <label>Max. Single Movement {panel.values.secMaxSingleMovement} seconds</label>
                      <Slider style={{"width": "100%"}} disabled={!panel.values.enable_movement}  min={60} max={600} step={10} defaultValue={panel.values.secMaxSingleMovement}  onChange={(_,data) => updatePanelValues('secMaxSingleMovement', data.value)} />
                    </div>

              </DialogContent>
            }

            <DialogActions>

              { panel.key === 'edit' &&
                      
                 <MySplitButton  label="Delete" disabled={panel.invalidArray.length >0}  items={[
                        {
                            key: 'reset',
                            text: 'Reset Recordings (keep camera)',
                            iconProps: { iconName: 'Refresh' },
                            onClick: savePanel
                        },
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
                   }]} />
                   
                }
              <Button appearance="primary" disabled={panel.invalidArray.length >0} onClick={savePanel}>Save</Button>
              <DialogTrigger disableButtonEnhancement >
                <Button appearance="secondary" onClick={() => setPanel({...panel, open: false, invalidArray: []})} >Close</Button>
              </DialogTrigger>

              {error &&
                <Alert intent='error' >
                {error}
                </Alert>
              }
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      
      </Dialog> 
    )
    
}