import {test,expect} from "@playwright/test";
import {imageRegionFromDrag,adjustImageRegion,validImageRegion} from "../../../packages/workbench-ui/src/image-region.ts";

test("缩略图正反拖动均固定原图像素，越界限制到原图边缘",()=>{
 const display={width:256,height:384},source={width:128,height:192};
 expect(imageRegionFromDrag({x:20,y:40},{x:100,y:168},display,source)).toEqual({x:10,y:20,width:40,height:64});
 expect(imageRegionFromDrag({x:100,y:168},{x:20,y:40},display,source)).toEqual({x:10,y:20,width:40,height:64});
 expect(imageRegionFromDrag({x:240,y:360},{x:900,y:700},display,source)).toEqual({x:120,y:180,width:8,height:12});
 expect(imageRegionFromDrag({x:-99,y:-99},{x:20,y:20},display,source)).toEqual({x:0,y:0,width:10,height:10});
 expect(imageRegionFromDrag({x:0,y:0},{x:0,y:0},display,source)).toBeUndefined();
 expect(imageRegionFromDrag({x:0,y:0},{x:1,y:1},{width:0,height:0},source)).toBeUndefined();
 expect(imageRegionFromDrag({x:NaN,y:0},{x:1,y:1},display,source)).toBeUndefined();
});
test("键盘移动与调宽高分别约束原图边界，不修改原区域",()=>{
 const size={width:128,height:192},region={x:10,y:20,width:40,height:64};
 expect(adjustImageRegion(region,size,"ArrowRight")).toEqual({...region,x:11});
 expect(adjustImageRegion(region,size,"ArrowDown",true)).toEqual({...region,height:65});
 const full={x:0,y:0,width:128,height:192};
 expect(adjustImageRegion(full,size,"ArrowRight")).toEqual(full);
 expect(adjustImageRegion(full,size,"ArrowDown",true)).toEqual(full);
 expect(validImageRegion({...region,x:0.5},size)).toBe(false);
 expect(validImageRegion({...region,width:0},size)).toBe(false);
 expect(region).toEqual({x:10,y:20,width:40,height:64});
});
