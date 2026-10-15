/** Fetch adapter for the existing route registrations. No dynamic code generation. */
export class FetchRouter {
  routes=[];
  get(path,fn){this.add('GET',path,fn);}
  post(path,fn){this.add('POST',path,fn);}
  put(path,fn){this.add('PUT',path,fn);}
  add(method,path,fn){this.routes.push({method,parts:path.split('/'),fn});}
  setErrorHandler(fn){this.errorHandler=fn;}
  async fetch(request){
    const url=new URL(request.url),parts=url.pathname.split('/');
    const route=this.routes.find(r=>r.method===request.method&&r.parts.length===parts.length&&r.parts.every((p,i)=>p.startsWith(':')||p===parts[i]));
    if(!route)return Response.json({error:{code:'NOT_FOUND'}},{status:404});
    let status=200,payload,sent=false;
    const reply={code(n){status=n;return this;},send(value){payload=value;sent=true;return this;}};
    const r={headers:Object.fromEntries(request.headers),ip:request.headers.get('CF-Connecting-IP')||'127.0.0.1',query:Object.fromEntries(url.searchParams),params:Object.fromEntries(route.parts.flatMap((p,i)=>p.startsWith(':')?[[p.slice(1),decodeURIComponent(parts[i])]]:[]))};
    try{
      if(!['GET','HEAD'].includes(request.method)){
        const text=await request.text();
        if(new TextEncoder().encode(text).length>256*1024)throw Object.assign(new Error('body too large'),{statusCode:413});
        try{r.body=text?JSON.parse(text):undefined;}catch{throw Object.assign(new Error('invalid JSON'),{statusCode:400});}
      }
      const result=await route.fn(r,reply);
      if(status===204)return new Response(null,{status});
      return Response.json(sent?payload:result??null,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
    }catch(error){
      if(this.errorHandler)await this.errorHandler(error,r,reply);
      else{status=500;payload={error:{code:'RETRYABLE_ERROR'}};}
      return Response.json(payload,{status,headers:{'Cache-Control':'no-store'}});
    }
  }
}
