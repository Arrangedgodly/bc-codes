import { MdModeEdit, MdDeleteForever } from "react-icons/md";

const Release = ({ release, setActiveRelease }: any) => {
  const handleActiveRelease = () => {
    setActiveRelease(release);
  }

  return (
    <div className="card max-w-[150px] max-h-[150px] bg-base-100 shadow-xl image-full m-5">
      <figure>
        <img src={release.image} alt={release.name} />
      </figure>
      <div className="justify-end card-body text-center">
        <h2 className="card-title m-auto text-xl">{release.name}</h2>
      </div>
      <div className="card-actions justify-center items-end">
        <label
          className="text-info btn btn-ghost btn-sm z-20 text-2xl"
          htmlFor="edit_release"
          onClick={handleActiveRelease}
        >
          <MdModeEdit />
        </label>
        <label
          className="text-error btn btn-ghost btn-sm z-20 text-2xl"
          htmlFor="delete_release"
          onClick={handleActiveRelease}
        >
          <MdDeleteForever />
        </label>
      </div>
    </div>
  );
};

export default Release;
