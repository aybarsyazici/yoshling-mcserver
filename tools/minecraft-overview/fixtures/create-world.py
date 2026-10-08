#!/usr/bin/env python3
"""Create synthetic Anvil data; never launches a game or reads an existing world."""
import argparse, gzip, hashlib, json, math, pathlib, struct, time, uuid, zlib

def string(value):
    value=value.encode("utf8"); return struct.pack(">H",len(value))+value
def signed(value): return value if value < 1 << 63 else value - (1 << 64)
def payload(kind, value):
    if kind==1:return struct.pack(">b",value)
    if kind==3:return struct.pack(">i",value)
    if kind==4:return struct.pack(">q",signed(value))
    if kind==5:return struct.pack(">f",value)
    if kind==7:return struct.pack(">i",len(value))+value
    if kind==8:return string(value)
    if kind==9:
        element,values=value
        return bytes([element])+struct.pack(">i",len(values))+b"".join(payload(element,v) for v in values)
    if kind==10:return b"".join(bytes([k])+string(n)+payload(k,v) for n,(k,v) in value.items())+b"\0"
    if kind==11:return struct.pack(">i",len(value))+b"".join(struct.pack(">i",v) for v in value)
    if kind==12:return struct.pack(">i",len(value))+b"".join(struct.pack(">q",signed(v)) for v in value)
    raise ValueError(kind)
def compound(value):return (10,value)
def nbt(value):return b"\x0a\0\0"+payload(10,value)
def block(name,**properties):
    value={"Name":(8,"minecraft:"+name)}
    if properties:value["Properties"]=compound({k:(8,v) for k,v in properties.items()})
    return value
PALETTE=[block("air"),block("stone"),block("dirt"),block("grass_block",snowy="false"),
         block("oak_planks"),block("cobblestone"),block("oak_log",axis="y"),block("glass"),
         block("bricks"),block("oak_leaves",distance="7",persistent="true",waterlogged="false"),
         block("water",level="0")]
def height(x,z):return 59+int(3*math.sin(x/15)+2*math.cos(z/13))
def at(x,y,z):
    top=height(x,z); result=1 if y<top-3 else 2 if y<top else 3 if y==top else 0
    if -22<=x<=-12 and 9<=z<=21:
        if y==60:return 10
        if y<60:return 2 if y>55 else 1
        result=0
    if -8<=x<=2 and -7<=z<=4:
        if top<y<=65:return 5
        if y==65:return 4
        if 66<=y<=70:
            edge=x in (-8,2) or z in (-7,4)
            if edge:
                if z==-7 and -4<=x<=-2 and y<=68:return 0
                if y in (68,69) and (x in (-8,2) and z in (-3,-2,1) or z==4 and x in (-5,-4,0)):return 7
                return 4
            return 0
        roof=71+max(0,3-int(abs(x+3)/2))
        if y==roof:return 8
    tree_top=height(14,9)+8
    if x==14 and z==9 and height(x,z)<y<=tree_top:return 6
    if abs(x-14)+abs(z-9)+abs(y-tree_top)<=5 and y>=tree_top-2:return 9
    if abs(x+26)+abs(z+18)+abs(y-68)<=6 and y>height(x,z):return 5
    return result
def packed(values,bits):
    per=64//bits;result=[]
    for offset in range(0,len(values),per):
        word=0
        for index,value in enumerate(values[offset:offset+per]):word|=value << (index*bits)
        result.append(word)
    return result
def chunk(cx,cz,data_version):
    sections=[]
    for sy in range(0,5):
        values=[at(cx*16+x,sy*16+y,cz*16+z) for y in range(16) for z in range(16) for x in range(16)]
        sections.append({"Y":(1,sy),"block_states":compound({"palette":(9,(10,PALETTE)),"data":(12,packed(values,4))}),
                         "biomes":compound({"palette":(9,(8,["minecraft:plains"]))}),
                         "SkyLight":(7,b"\xff"*2048),"BlockLight":(7,b"\0"*2048)})
    heights=[]
    for z in range(16):
        for x in range(16):
            gx,gz=cx*16+x,cz*16+z
            surface=max(y for y in range(80) if at(gx,y,gz)!=0)
            heights.append(surface+65)
    return nbt({"DataVersion":(3,data_version),"xPos":(3,cx),"zPos":(3,cz),"yPos":(3,-4),
                "Status":(8,"minecraft:full"),"LastUpdate":(4,100),"InhabitedTime":(4,100),
                "isLightOn":(1,1),"sections":(9,(10,sections)),
                "Heightmaps":compound({"WORLD_SURFACE":(12,packed(heights,9)),"OCEAN_FLOOR":(12,packed(heights,9))}),
                "block_entities":(9,(10,[]))})
def create(output,version,layout):
    if output.exists():raise ValueError("Fixture output already exists")
    data_version=4790 if version=="26.1.2" else 3955
    output.mkdir(parents=True)
    world=output/"world"; region=world/("dimensions/minecraft/overworld/region" if layout=="namespaced" else "region")
    region.mkdir(parents=True)
    data={"DataVersion":(3,data_version),"LevelName":(8,"Synthetic overview fixture"),
          "Version":compound({"Id":(3,data_version),"Name":(8,version),"Snapshot":(1,0)}),
          "WorldGenSettings":compound({"dimensions":compound({"minecraft:overworld":compound({"type":(8,"minecraft:overworld")})})})}
    if layout=="namespaced":data["spawn"]=compound({"dimension":(8,"minecraft:overworld"),"pos":(11,[0,66,0]),"yaw":(5,0),"pitch":(5,0)})
    else:data.update({"SpawnX":(3,0),"SpawnY":(3,66),"SpawnZ":(3,0)})
    (world/"level.dat").write_bytes(gzip.compress(nbt({"Data":compound(data)}),mtime=0))
    regions={}
    for cx in range(-4,4):
        for cz in range(-4,4):
            key=(cx//32,cz//32); regions.setdefault(key,[]).append((cx,cz,zlib.compress(chunk(cx,cz,data_version),9)))
    for (rx,rz),chunks in regions.items():
        locations=bytearray(4096);timestamps=bytearray(4096);body=bytearray();sector=2
        for cx,cz,compressed in chunks:
            record=struct.pack(">I",len(compressed)+1)+b"\x02"+compressed
            count=(len(record)+4095)//4096;index=(cx%32)+(cz%32)*32
            locations[index*4:index*4+4]=(sector<<8|count).to_bytes(4,"big")
            timestamps[index*4:index*4+4]=(1700000000).to_bytes(4,"big")
            body.extend(record+b"\0"*(count*4096-len(record)));sector+=count
        (region/f"r.{rx}.{rz}.mca").write_bytes(locations+timestamps+body)
    files=[]
    for path in sorted(world.rglob("*")):
        if path.is_file():files.append({"path":path.relative_to(world).as_posix(),"bytes":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest()})
    fingerprint=hashlib.sha256(json.dumps(files,separators=(",",":")).encode()).hexdigest()
    manifest={"format":1,"profileId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","jobId":str(uuid.uuid4()),
              "target":{"mcVersion":version,"loader":"fabric","loaderVersion":"0.19.5","javaVariant":"java25"},
              "source":{"kind":"synthetic-fixture","id":"synthetic-spawn-village","sha256":fingerprint,
                        "snapshotAt":"2026-10-08T00:00:00.000Z","sourceSavedAt":"2026-10-08T00:00:00.000Z"},
              "center":{"x":0,"z":0},"radius":64,"dimension":"overworld","layout":layout,"files":files}
    (output/"manifest.json").write_text(json.dumps(manifest,indent=2)+"\n")
    print(json.dumps({"input":str(output),"sourceBytes":sum(f["bytes"] for f in files),"sourceHash":fingerprint,"regions":len(regions)}))
if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--output",type=pathlib.Path,required=True)
    parser.add_argument("--version",choices=["26.1.2","1.21.1"],default="26.1.2")
    parser.add_argument("--layout",choices=["namespaced","legacy"],default="namespaced")
    args=parser.parse_args();create(args.output,args.version,args.layout)
