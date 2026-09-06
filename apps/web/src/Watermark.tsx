import {createContext,useContext,useMemo,type ReactNode} from 'react';
import {watermarkImage} from './watermark-image';
const UserIdContext=createContext<string|null>(null);
export function Watermark(){
  const userId=useContext(UserIdContext);
  const backgroundImage=useMemo(()=>userId?watermarkImage(userId):undefined,[userId]);
  return userId?<div className="user-watermark" aria-hidden="true" style={{backgroundImage}}/>:null;
}
export function WatermarkedPage({userId,children}:{userId:string;children:ReactNode}){
  return <UserIdContext.Provider value={userId}>{children}<Watermark/></UserIdContext.Provider>;
}
